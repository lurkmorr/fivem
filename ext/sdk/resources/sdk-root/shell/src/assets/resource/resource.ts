import { inject, injectable } from "inversify";
import { IMinimatch, Minimatch } from 'minimatch';
import { GameServerService } from "backend/game-server/game-server-service";
import { resourceManifestFilename, resourceManifestLegacyFilename } from 'backend/constants';
import { fastRandomId } from 'utils/random';
import { FilesystemEntry } from "shared/api.types";
import { LogService } from "backend/logger/log-service";
import { FsService } from "backend/fs/fs-service";
import { ProjectAccess } from "backend/project/project-access";
import { ResourceManifest } from "./resource-manifest";
import { ShellCommand } from "backend/process/ShellCommand";
import { NotificationService } from "backend/notification/notification-service";
import { DisposableContainer } from "backend/disposable-container";
import { StatusProxy, StatusService } from "backend/status/status-service";
import { OutputService } from "backend/output/output-service";
import { uniqueArray } from "utils/unique";
import { Deferred } from "backend/deferred";
import { AssetBuildCommandError } from "backend/project/asset/asset-error";
import { AssetDeployablePathsDescriptor, AssetInterface } from "assets/core/asset-interface";
import { ProjectAssetBaseConfig } from "shared/project.types";
import { FsWatcherEventType } from "backend/fs/fs-watcher";
import { ResourceAssetConfig, ResourceStatus } from "./resource-types";
import { assetTypes } from "shared/asset.types";
import { ServerResourceDescriptor } from "backend/game-server/game-server-runtime";


interface IdealResourceMetaData {
  client_script: string[];
  client_scripts: string[];
  shared_script: string[];
  shared_scripts: string[];
  server_script: string[];
  server_scripts: string[];
};

export type ResourceMetaData = Partial<IdealResourceMetaData>;

const resourceGlobConfig = {
  dot: true,
  nobrace: true,
  nocase: true,
  nocomment: true,
  noext: true,
  nonegate: true,
  nonull: true,
};

@injectable()
export class Resource implements AssetInterface {
  readonly type = assetTypes.resource;

  getName() {
    return this.entry.name;
  }

  getPath() {
    return this.entry.path;
  }

  get name(): string {
    return this.entry.name;
  }

  get path(): string {
    return this.entry.path;
  }

  @inject(GameServerService)
  protected readonly gameServerService: GameServerService;

  @inject(LogService)
  protected readonly logService: LogService;

  @inject(FsService)
  protected readonly fsService: FsService;

  @inject(ProjectAccess)
  protected readonly projectAccess: ProjectAccess;

  @inject(NotificationService)
  protected readonly notificationService: NotificationService;

  @inject(StatusService)
  protected readonly statusService: StatusService;

  @inject(OutputService)
  protected readonly outputService: OutputService;

  protected entry: FilesystemEntry;

  protected manifest: ResourceManifest = new ResourceManifest();
  protected manifestPath: string;

  protected metaData: ResourceMetaData = {};
  protected metaDataLoading = true;

  protected restartInducingPaths: string[] = [];
  protected restartInducingPatterns: Record<string, IMinimatch> = {};

  protected buildCommandsDisposableContainer = new DisposableContainer();
  protected disposableContainer = new DisposableContainer();
  protected status: StatusProxy<ResourceStatus>;

  private watchCommandsSuspended = false;
  private runningWatchCommands: Map<string, ShellCommand> = new Map();

  setEntry(assetEntry: FilesystemEntry) {
    this.entry = assetEntry;
    this.resourceDescriptor = {
      name: this.getName(),
      path: this.getPath(),
    };
  }

  getConfig(): ResourceAssetConfig {
    return {
      restartOnChange: false,
      ...this.projectAccess.getInstance().getAssetConfig(this.path),
    };
  }

  private resourceDescriptor: ServerResourceDescriptor;
  getResourceDescriptor() {
    return this.resourceDescriptor;
  }

  getDefinition() {
    return {
      convarCategories: this.manifest.convarCategories,
    }
  }

  async getIgnorePatterns(): Promise<string[]> {
    return this.fsService.readIgnorePatterns(this.getPath());
  }

  async getDeployablePathsDescriptor(): Promise<AssetDeployablePathsDescriptor> {
    const resourcePath = this.getPath();
    const ignorePatterns = await this.getIgnorePatterns();

    // Mark all patterns from `.fxdkignore` as exclusions and add others
    const patternPaths = ignorePatterns
      .map((pattern) => '!' + pattern.replace(/\\/g, '/'))
      .concat('**/*');

    const allPaths = await this.fsService.glob(
      patternPaths,
      {
        cwd: resourcePath.replace(/\\/g, '/'),
      },
    );

    return {
      root: resourcePath,
      paths: uniqueArray([
        ...allPaths,
        this.fsService.relativePath(resourcePath, this.manifestPath),
      ]),
    };
  }

  async suspendWatchCommands() {
    if (this.watchCommandsSuspended) {
      return;
    }

    this.watchCommandsSuspended = true;

    await this.stopAllWatchCommands();
  }

  resumeWatchCommands() {
    if (!this.watchCommandsSuspended) {
      return;
    }

    this.watchCommandsSuspended = false;

    this.ensureWatchCommandsRunning();
  }

  async build() {
    if (!this.buildCommandsDisposableContainer.empty()) {
      this.buildCommandsDisposableContainer.dispose();
      this.buildCommandsDisposableContainer = new DisposableContainer();
    }

    const commands = this.manifest.fxdkBuildCommands;
    if (!commands.length) {
      return;
    }

    await this.suspendWatchCommands();

    const promises = commands.map(([cmd, args]) => {
      const shellCommand = new ShellCommand(cmd, Array.isArray(args) ? args : [], this.path);
      const shellCommandOutputChannel = this.outputService.createOutputChannelFromProvider(shellCommand);

      this.buildCommandsDisposableContainer.add(shellCommandOutputChannel);

      const outputId = shellCommand.getOutputChannelId();
      const deferred = new Deferred();

      let closed = false;

      shellCommand.onClose((code) => {
        if (!closed) {
          closed = true;

          if (code === 0) {
            deferred.resolve();
          } else {
            deferred.reject(new AssetBuildCommandError(
              this.name,
              outputId,
            ));
          }
        }
      });

      shellCommand.onError((error) => {
        if (!closed) {
          closed = true;
          deferred.reject(error);
        }
      });

      shellCommand.start();

      return deferred.promise;
    });

    await Promise.all(promises);

    await this.resumeWatchCommands();
  }

  async init() {
    this.disposableContainer.add(
      this.status = this.statusService.createProxy(`resource-${this.path}`),
    );

    this.status.setValue({
      watchCommands: {},
    });

    this.projectAccess.withInstance((project) => {
      this.disposableContainer.add(project.onAssetConfigChanged(this.path, (cfg) => this.onConfigChanged(cfg)));
    });

    const manifestPath = this.fsService.joinPath(this.path, resourceManifestFilename);
    const legacyManifestPath = this.fsService.joinPath(this.path, resourceManifestLegacyFilename);

    if (await this.fsService.statSafe(manifestPath)) {
      this.manifestPath = manifestPath;
    } else if (await this.fsService.statSafe(legacyManifestPath)) {
      this.manifestPath = legacyManifestPath;
    }

    this.loadMetaData();
  }

  async onFsUpdate(updateType: FsWatcherEventType, entry: FilesystemEntry | null, entryPath: string) {
    // If no more manifest - this no longer a resource, rip
    if (updateType === FsWatcherEventType.DELETED && entryPath === this.manifestPath) {
      this.logService.log(`Releasing ${this.name} as manifest got deleted`);

      return this.projectAccess.withInstance((project) => {
        project.getAssets().release(this.getPath());
      });
    }

    const isChange = updateType === FsWatcherEventType.MODIFIED;

    const { enabled, restartOnChange } = this.getConfig();
    if (!enabled) {
      return;
    }

    if (isChange && entry?.path === this.manifestPath) {
      this.logService.log(`Reloading ${this.name} meta data as manifest for changed`);
      this.loadMetaData();
      return this.gameServerService.reloadResource(this.name);
    }

    // No restarts while meta data is being loaded
    if (this.metaDataLoading) {
      this.logService.log('Meta data for resource is still loading, ignoring change fs update', updateType, entry);
      return;
    }

    if (!isChange || !restartOnChange) {
      return;
    }

    const isRestartInducingPath = Object.values(this.restartInducingPatterns)
      .some((pattern) => {
        return pattern.match(entry.path);
      });

    if (isRestartInducingPath) {
      this.logService.log(`[Resource ${this.name}] Restarting resource`, this.name);
      this.gameServerService.restartResource(this.name);
    }
  }

  async dispose() {
    await this.disposableContainer.dispose();

    await Promise.all([...this.runningWatchCommands.values()].map((cmd) => cmd.stop()));
  }

  private async ensureWatchCommandsRunning() {
    if (this.watchCommandsSuspended) {
      return;
    }

    const { enabled, restartOnChange } = this.getConfig();
    if (!enabled || !restartOnChange) {
      this.stopAllWatchCommands();

      return;
    }

    const stubs: Record<string, { command: string, args: unknown }> = this.manifest.fxdkWatchCommands.reduce((acc, [command, args]) => {
      acc[JSON.stringify([command, args])] = { command, args };

      return acc;
    }, {});

    // Killing old promises
    const oldCommandsPromises = [];
    const commandHashesToDelete = [];

    this.runningWatchCommands.forEach((cmd, hash) => {
      if (!stubs[hash]) {
        oldCommandsPromises.push(cmd.stop());
        commandHashesToDelete.push(hash);

        this.runningWatchCommands.delete(hash);
      }
    });

    this.status.applyValue((status) => {
      if (status) {
        commandHashesToDelete.forEach((hash) => status.watchCommands[hash]);
      }

      return status;
    });

    await Promise.all(oldCommandsPromises);

    // Starting commands
    Object.entries(stubs).map(([hash, { command, args }]) => {
      if (!this.runningWatchCommands.has(hash)) {
        return this.startWatchCommand(hash, command, args);
      }
    });
  }

  private async stopWatchCommand(hash: string) {
    const cmd = this.runningWatchCommands.get(hash);
    if (cmd) {
      this.runningWatchCommands.delete(hash);

      await cmd.stop();

      this.status.applyValue((status) => {
        if (status) {
          status.watchCommands[hash].running = false;
        }

        return status;
      });
    }
  }

  private async startWatchCommand(hash: string, command: string, args: unknown) {
    const cmd = new ShellCommand(command, Array.isArray(args) ? args : [], this.path);
    const cmdChannel = this.outputService.createOutputChannelFromProvider(cmd);
    const outputId = cmd.getOutputChannelId();

    this.runningWatchCommands.set(hash, cmd);

    cmd.onClose(() => {
      cmdChannel.dispose();

      this.status.applyValue((status) => {
        if (status) {
          status.watchCommands[hash] = {
            outputChannelId: outputId,
            running: false,
          };
        }

        return status;
      });
    });

    cmd.onError((err) => {
      this.notificationService.error(`Watch command for resource ${this.name} has failed to start: ${err.toString()}`);
    });

    cmd.start();

    this.status.applyValue((status) => {
      if (status) {
        status.watchCommands[hash] = {
          outputChannelId: outputId,
          running: true,
        };
      }

      return status;
    });
  }

  private async stopAllWatchCommands() {
    if (this.runningWatchCommands.size === 0) {
      return;
    }

    const promises: Promise<void>[] = [];

    this.runningWatchCommands.forEach((_cmd, hash) => {
      promises.push(this.stopWatchCommand(hash));
    });

    await Promise.all(promises);
  }

  private rebuildRestartInducingPatterns() {
    const scripts = new Set([
      ...this.manifest.getAllScripts(),
      ...this.manifest.getFiles(),
    ]);

    this.restartInducingPatterns = {};

    scripts.forEach((script) => {
      const fullScript = this.fsService.joinPath(this.path, script);

      this.restartInducingPatterns[script] = new Minimatch(fullScript, resourceGlobConfig);
    });
  }

  private async onConfigChanged(config: ProjectAssetBaseConfig) {
    this.ensureWatchCommandsRunning();
  }

  private async loadMetaData(): Promise<void> {
    this.metaDataLoading = true;

    this.logService.log('Loading resource meta data', this.name);

    return new Promise((resolve, reject) => {
      const uid = this.name + '-' + fastRandomId();
      const timeout = setTimeout(() => {
        this.metaDataLoading = false;
        reject(`Resource ${this.path} meta data load timed out after 5 seconds`);
      }, 5000);

      const cb = (resName: string, metaData: ResourceMetaData) => {
        if (resName === uid) {
          clearTimeout(timeout);
          RemoveEventHandler('sdk:resourceMetaDataResponse', cb);

          try {
            this.manifest.fromObject(metaData);
          } catch (e) {
            this.logService.log('Failed to populate manifest', e.toString());
            this.metaDataLoading = false;
            return;
          }

          this.metaData = metaData;
          this.metaDataLoading = false;

          this.logService.log(`#${this.getName()} restart inducing files:`, this.restartInducingPaths);

          this.rebuildRestartInducingPatterns();
          this.ensureWatchCommandsRunning();
          this.projectAccess.getInstance().getAssets().resolveMetadata(this);

          return resolve();
        }
      };

      on('sdk:resourceMetaDataResponse', cb);
      emit('sdk:requestResourceMetaData', this.path, uid);
    });
  }
}
