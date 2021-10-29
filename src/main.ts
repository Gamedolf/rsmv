import { app, BrowserWindow, ipcMain } from "electron/main";
import * as updater from "./updater";
import * as downloader from "./downloader";
import * as gamecache from "./cache";
import { GameCacheLoader } from "./cacheloader";
import * as path from "path";
import { loadDds } from "./3d/ddsimage";

(global as any).dds = loadDds;

//skip command line arguments until we find two args that aren't flags (electron.exe and the main script)
//we have to do this since electron also includes flags like --inspect in argv
let args = process.argv.slice();
for (let skip = 2; skip > 0 && args.length > 0; args.shift()) {
	if (!args[0].startsWith("-")) { skip--; }
}
let cachedir = "cache";
let mode: "localcache" | "gamecache" | "streaming" = "streaming";
let gamecachedir = path.resolve(process.env.ProgramData!, "jagex/runescape");
let arg: string | undefined;

//npm start -- [--streaming] [--local[=filedir]] [--cache[=gamecachedir]]
//TODO add this to ui instead
while (arg = args.shift()) {
	let m = arg.match(/--?(\w+)(=(.*))?/);
	if (m) {
		if (m[1] == "streaming") {
			mode = "streaming";
		}
		if (m[1] == "local") {
			mode = "localcache";
			if (m[3]) { cachedir = m[3]; }
		}
		if (m[1] == "cache") {
			mode = "gamecache";
			if (m[3]) { gamecachedir = m[3]; }
		}
	}
}

let viewerFileSource: CacheFileSource;
//where does the viewer get its files
switch (mode) {
	case "streaming":
		viewerFileSource = new downloader.Downloader(cachedir);
		break;
	case "localcache":
		viewerFileSource = updater.fileSource;
		break;
	case "gamecache":
		viewerFileSource = new GameCacheLoader(gamecachedir);
		break;
	default:
		throw new Error("unknown mode");
}

//expose to global for debugging
(global as any).loader = viewerFileSource;

//having reused renderen processes breaks the node fs module
//this still hasn't been fixed in electron
app.allowRendererProcessReuse = false;

app.whenReady().then(async () => {
	var splash: BrowserWindow | null = null;
	if (viewerFileSource == updater.fileSource) {
		splash = await createWindow("assets/splash.html", { width: 377, height: 144, frame: false, resizable: false, webPreferences: { nodeIntegration: true } });

		updater.on("update-progress", (args) => {
			splash!.webContents.send("update-progress", args);
		});
		await updater.run(cachedir);
		//hide instead of close so electron doesn't shut down
		splash.hide();
	}
	var index = await createWindow(`assets/index.html`, { width: 800, height: 600, frame: false, webPreferences: { enableRemoteModule: true, nodeIntegration: true, contextIsolation: false, additionalArguments: ["cachedir=" + cachedir] } });

	index.webContents.openDevTools({ mode: "detach" });
	splash?.close();
});


export interface CacheFileSource {
	getFile(major: number, minor: number, crc?: number): Promise<Buffer>;
	getFileArchive(index: gamecache.CacheIndex): Promise<gamecache.SubFile[]>;
	getFileById(major: number, fileid: number): Promise<Buffer>;

	close(): void;
}

ipcMain.handle("load-cache-file", async (e, major: number, fileid: number) => {
	if (viewerFileSource instanceof downloader.Downloader) {
		if (viewerFileSource.closed) {
			viewerFileSource = new downloader.Downloader(cachedir);
			(global as any).loader = viewerFileSource;
		}
	}
	if (viewerFileSource instanceof GameCacheLoader) {
		//redirect png textures to dds textures
		if (major == 53) { major = 52; }
	}
	let file = await viewerFileSource.getFileById(major, fileid);
	return file;
});

async function createWindow(page: string, options: Electron.BrowserWindowConstructorOptions) {
	const window = new BrowserWindow(options);
	await window.loadFile(page);
	return window;
}

app.on("window-all-closed", () => {
	// MacOS stuff I guess?
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", () => {
	// MacOS stuff I guess?
	if (BrowserWindow.getAllWindows().length === 0) {
		//TODO this doesn't make any sense
		//@ts-ignore
		createWindow();
	}
});



// 135 795
// 135 943


// Oak 5
// Beech 5
// Hickory 5
// Yew 6
// Birch 5
// Ash 5