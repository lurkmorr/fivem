-- is updater?
local function isLauncherPersonality(name)
	return name == 'main'
end

-- is game host?
local function isGamePersonality(name)
	if _OPTIONS['game'] ~= 'five' and _OPTIONS['game'] ~= 'rdr3' and _OPTIONS['game'] ~= 'ny' then
		return isLauncherPersonality(name)
	end

	if name == 'game_mtl' then
		return true
	end

	if name == 'game_1604' or name == 'game_2060' or name == 'game_372' or name == 'game_2189' then
		return true
	end
	
	if name == 'game_1311' or name == 'game_1355' then
		return true
	end
	
	if name == 'game_43' then
		return true
	end
	
	if isLauncherPersonality(name) then
		filter { "configurations:Debug" }
		return true
	end
	
	return false
end

local function launcherpersonality_inner(name, aslr)
	local projectName = name == 'main' and 'CitiLaunch' or ('CitiLaunch_' .. name)

	if aslr then
		projectName = projectName .. '_aslr'
	end

	project(projectName)
		language "C++"
		kind "WindowedApp"
		
		defines { "COMPILING_LAUNCH", "COMPILING_LAUNCHER" }
		
		defines("LAUNCHER_PERSONALITY_" .. name:upper())

		flags { "NoManifest", "NoImportLib" }
		
		symbols "Full"
		buildoptions "/MP"
		
		links { "SharedLibc", "dbghelp", "psapi", "comctl32", "breakpad", "wininet", "winhttp", "crypt32" }
		
		if isLauncherPersonality(name) then
			links "Win2D"
			
			add_dependencies { 'vendor:minhook-crt' }
		else
			targetextension '.bin'
		end
		
		dependson { "retarget_pe", "pe_debug" }

		files
		{
			"**.cpp", "**.h", 
			"launcher.rc", "launcher.def",
			"../common/Error.cpp",
			"../common/CfxLocale.Win32.cpp",
		}
		
		if isGamePersonality(name) then
			if _OPTIONS['game'] == 'five' then
				local gameBuild = '1604'
				
				if name == 'game_2189' then gameBuild = '2189_0' end
				if name == 'game_2060' then gameBuild = '2060_2' end
				if name == 'game_372' then gameBuild = '372' end

				local gameDump = ("C:\\f\\GTA5_%s_dump.exe"):format(gameBuild)

				if name == 'game_mtl' then
					gameDump = "C:\\f\\Launcher.exe"
					gameBuild = 'mtl'
				end
			
				postbuildcommands {
					("if exist %s ( %%{cfg.buildtarget.directory}\\retarget_pe \"%%{cfg.buildtarget.abspath}\" %s )"):format(
						gameDump, gameDump
					),
					("if exist \"%s\" ( %%{cfg.buildtarget.directory}\\pe_debug \"%%{cfg.buildtarget.abspath}\" \"%s\" )"):format(
						path.getabsolute(('../../tools/dbg/dump_%s.txt'):format(gameBuild)),
						path.getabsolute(('../../tools/dbg/dump_%s.txt'):format(gameBuild))
					)
				}

				resign()
			elseif _OPTIONS['game'] == 'rdr3' then
				local gameBuild = '1311'
				
				if name == 'game_1355' then gameBuild = '1355_18' end

				local gameDump = ("C:\\f\\RDR2_%s.exe"):format(gameBuild)

				if name == 'game_mtl' then
					gameDump = "C:\\f\\Launcher.exe"
					gameBuild = 'mtl'
				end
			
				postbuildcommands {
					("if exist %s ( %%{cfg.buildtarget.directory}\\retarget_pe \"%%{cfg.buildtarget.abspath}\" %s )"):format(
						gameDump, gameDump
					),
				}

				resign()
			end
		end
		
		filter {}
		
		if isLauncherPersonality(name) then
			postbuildcommands {
				"echo. > %{cfg.buildtarget.abspath}.formaldev",
			}
		end
		
		pchsource "StdInc.cpp"
		pchheader "StdInc.h"

		add_dependencies { 'vendor:breakpad', 'vendor:tinyxml2', 'vendor:xz-crt', 'vendor:minizip-crt', 'vendor:tbb-crt', 'vendor:concurrentqueue', 'vendor:boost_locale-crt' }
		
		if isLauncherPersonality(name) then
			add_dependencies { 'vendor:curl-crt', 'vendor:cpr-crt', 'vendor:mbedtls_crt', 'vendor:hdiffpatch-crt' }
		end

		add_dependencies { 'vendor:openssl_crypto_crt' }
		
		--includedirs { "client/libcef/", "../vendor/breakpad/src/", "../vendor/tinyxml2/" }

		staticruntime 'On'

		filter { "options:game=ny" }
			targetname "LibertyM"

		filter { "options:game=payne" }
			targetname "CitizenPayne"

		filter { "options:game=five" }
			targetname "FiveM"
			
		filter { "options:game=launcher" }
			targetname "CfxLauncher"

		filter {}
			
		if name ~= 'main' then
			targetname("CitizenFX_SubProcess_" .. name .. (aslr and "_aslr" or ""))
		end
		
		linkoptions "/IGNORE:4254 /LARGEADDRESSAWARE" -- 4254 is the section type warning we tend to get
		
		if isGamePersonality(name) then
			if not aslr and not isLauncherPersonality(name) then
				linkoptions { "/SAFESEH:NO", "/DYNAMICBASE:NO" }
			else
				filter { "configurations:Debug" }
					linkoptions { "/SAFESEH:NO", "/DYNAMICBASE:NO" }

				filter {}
			end

			-- VS14 linker behavior change causes the usual workaround to no longer work, use an undocumented linker switch instead
			-- note that pragma linker directives ignore these (among other juicy arguments like /WBRDDLL, /WBRDTESTENCRYPT and other
			-- Microsoft Warbird-specific DRM functions... third-party vendors have to handle their own way of integrating
			-- PE parsing and writing, yet Microsoft has their feature hidden in the exact linker those vendors use...)
			linkoptions "/LAST:.zdata"
		end
		
		-- reset isGamePersonality bit
		filter {}

		if name == 'chrome' then
			-- Chrome is built with an 8MB initial stack, and render processes' V8 stack limit assumes such as well
			linkoptions "/STACK:0x800000"
		end
			
			linkoptions "/DELAYLOAD:d3d11.dll /DELAYLOAD:d2d1.dll /DELAYLOAD:d3dcompiler_47.dll /DELAYLOAD:dwrite.dll /DELAYLOAD:ole32.dll /DELAYLOAD:shcore.dll /DELAYLOAD:api-ms-win-core-winrt-error-l1-1-1.dll /DELAYLOAD:api-ms-win-core-winrt-l1-1-0.dll /DELAYLOAD:api-ms-win-core-winrt-error-l1-1-0.dll /DELAYLOAD:api-ms-win-core-winrt-string-l1-1-0.dll /DELAYLOAD:api-ms-win-shcore-stream-winrt-l1-1-0.dll"
end

local function launcherpersonality(name)
	launcherpersonality_inner(name, false)

	if name:sub(1, 5) == 'game_' and _OPTIONS['game'] ~= 'ny' and name ~= 'game_mtl' then
		launcherpersonality_inner(name, true)
	end
end

launcherpersonality 'main'
launcherpersonality 'chrome'

if _OPTIONS['game'] == 'five' then
	launcherpersonality 'game_1604'
	--launcherpersonality 'game_372'
	launcherpersonality 'game_2060'
	launcherpersonality 'game_2189'
	launcherpersonality 'game_mtl'
elseif _OPTIONS['game'] == 'rdr3' then
	launcherpersonality 'game_1311'
	launcherpersonality 'game_1355'
	launcherpersonality 'game_mtl'
elseif _OPTIONS['game'] == 'ny' then
	launcherpersonality 'game_43'
end

project 'CitiLaunch_TLSDummy'
	kind 'SharedLib'
	language 'C++'

	defines { 'IS_TLS_DLL' }

	staticruntime 'On'

	files {
		'DummyVariables.cpp'
	}

externalproject "Win2D"
	if os.getenv('COMPUTERNAME') ~= 'AVALON' and not os.getenv('CI') then
		filename "../../../vendor/win2d/winrt/lib/winrt.lib.uap"
	else
		filename "../../vendor/win2d/winrt/lib/winrt.lib.uap"
	end
	uuid "26b85b6e-3520-42b5-adb6-971010cc99fa"
	kind "StaticLib"
	language "C++"
	