
import { ThreeJsRenderer } from "./threejsrender";
import * as React from "react";
import { boundMethod } from "autobind-decorator";
import { WasmGameCacheLoader } from "../cache/sqlitewasm";
import { CacheFileSource, cachingFileSourceMixin } from "../cache";
import * as datastore from "idb-keyval";
import { EngineCache, ThreejsSceneCache } from "../3d/ob3tothree";
import { InputCommitted, StringInput, JsonDisplay, IdInput, LabeledInput, TabStrip, CanvasView } from "./commoncontrols";
import { Openrs2CacheMeta, Openrs2CacheSource } from "../cache/openrs2loader";
import { GameCacheLoader } from "../cache/sqlite";

import { UIScriptFile } from "./scriptsui";
import { DecodeErrorJson } from "../scripts/testdecode";
import prettyJson from "json-stringify-pretty-compact";
import { delay, drawTexture, TypedEmitter } from "../utils";
import { ParsedTexture } from "../3d/textures";
import { Downloader } from "../cache/downloader";

// @ts-ignore type import also fails when targeting web
import type * as electronType from "electron/renderer";

const electron = (() => {
	try {
		if (typeof __non_webpack_require__ != "undefined") {
			return __non_webpack_require__("electron/renderer") as typeof electronType;
		}
	} catch (e) { }
	return null;
})();

export type SavedCacheSource = {
	type: string
} & ({
	type: "sqlitehandle",
	handle: FileSystemDirectoryHandle
} | {
	type: "sqliteblobs",
	blobs: Record<string, Blob>
} | {
	type: "openrs2",
	cachename: string
} | {
	type: "sqlitenodejs",
	location: string
} | {
	type: "live"
});

export async function downloadBlob(name: string, blob: Blob) {
	if (!electron) {
		let a = document.createElement("a");
		let url = URL.createObjectURL(blob);
		a.download = name;
		a.href = url;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1);
	} else {
		//TODO
		console.log("TODO");
	}
}

/**@deprecated requires a service worker and is pretty sketchy, also no actual streaming output file sources atm */
export async function downloadStream(name: string, stream: ReadableStream) {
	if (!electron) {
		let url = new URL(`download_${Math.random() * 10000 | 0}_${name}`, document.location.href).href;
		let sw = await navigator.serviceWorker.ready;
		if (!sw.active) { throw new Error("no service worker"); }
		sw.active.postMessage({ type: "servedata", url, stream }, [stream as any]);
		await delay(100);
		let fr = document.createElement("iframe");
		fr.src = url;
		fr.hidden = true;
		document.body.appendChild(fr);
	} else {
		//TODO
		console.log("TODO");
	}
}

function OpenRs2IdSelector(p: { initialid: number, onSelect: (id: number) => void }) {
	let [caches, setCaches] = React.useState<Openrs2CacheMeta[] | null>(null);
	let [relevantcaches, setrelevantcaches] = React.useState<Openrs2CacheMeta[] | null>(null);
	let [loading, setLoading] = React.useState(false);
	let [relevantonly, setrelevantonly] = React.useState(true);
	let [gameFilter, setGameFilter] = React.useState("runescape");
	let [yearFilter, setYearfilter] = React.useState("");
	let [langFilter, setLangfilter] = React.useState("en");
	let loadprom = React.useRef<Promise<{ caches: Openrs2CacheMeta[], relevant: Openrs2CacheMeta[] }> | null>(null);

	let loadcaches = React.useCallback(() => {
		if (!loadprom.current) {
			loadprom.current = Openrs2CacheSource.getCacheIds().then(caches => {

				let relevant = caches.filter(q => q.language == "en" && q.sources.includes("Jagex") && q.environment == "live" && q.game == "runescape")
					.sort((a, b) => +new Date(b.timestamp ?? "") - +new Date(a.timestamp ?? ""));

				return { caches, relevant };
			});
		}
		return loadprom.current;
	}, []);

	let openselector = React.useCallback(async () => {
		setLoading(true);
		let { caches, relevant } = await loadcaches();
		setCaches(caches);
		setrelevantcaches(relevant);
	}, [])


	let games: string[] = [];
	let years: string[] = [];
	let langs: string[] = [];
	for (let cache of caches ?? []) {
		if (cache.timestamp) {
			let year = "" + new Date(cache.timestamp ?? 0).getUTCFullYear();
			if (years.indexOf(year) == -1) { years.push(year); }
		}
		if (games.indexOf(cache.game) == -1) { games.push(cache.game); }
		if (langs.indexOf(cache.language) == -1) { langs.push(cache.language); }
	}

	years.sort((a, b) => (+b) - (+a));

	let showncaches = ((relevantonly ? relevantcaches : caches) ?? []).filter(cache => {
		if (gameFilter && cache.game != gameFilter) { return false; }
		if (langFilter && cache.language != langFilter) { return false; }
		if (yearFilter && new Date(cache.timestamp ?? 0).getUTCFullYear() != +yearFilter) { return false; }
		return true;
	});
	showncaches.sort((a, b) => +new Date(b.timestamp ?? 0) - +new Date(a.timestamp ?? 0));

	let enterCacheId = async (idstring: string) => {
		let id = +idstring;
		if (id > 0) {
			p.onSelect(id);
		} else {
			let { relevant } = await loadcaches();
			p.onSelect(relevant[-id].id);
		}
	}

	return (
		<React.Fragment>
			<StringInput initialid={p.initialid + ""} onChange={enterCacheId} />
			{!loading && !caches && <input type="button" className="sub-btn" onClick={openselector} value="More options..." />}
			{caches && (
				<React.Fragment>
					<div style={{ overflowY: "auto" }}>
						<table>
							<thead>
								<tr>
									<td></td>
									{/* <td>
										<select value={gameFilter} onChange={e => setGameFilter(e.currentTarget.value)}>
											<option value="">Game</option>
											{games.map(game => <option key={game} value={game}>{game}</option>)}
										</select>
									</td> */}
									{/* <td>
										<select value={langFilter} onChange={e => setLangfilter(e.currentTarget.value)}>
											<option value="">--</option>
											{langs.map(lang => <option key={lang} value={lang}>{lang}</option>)}
										</select>
									</td> */}
									<td>
										<select value={yearFilter} onChange={e => setYearfilter(e.currentTarget.value)}>
											<option value="">Date</option>
											{years.map(year => <option key={year} value={year}>{year}</option>)}
										</select>
									</td>
									<td>
										Build
									</td>
								</tr>
							</thead>
							<tbody>
								{showncaches.map(cache => (
									<tr key={cache.language + cache.id}>
										<td><input type="button" value="-" className="sub-btn" onClick={p.onSelect.bind(null, cache.id)} /></td>
										{/* <td>{cache.game}</td> */}
										{/* <td>{cache.language}</td> */}
										<td>{cache.timestamp ? new Date(cache.timestamp).toDateString() : ""}</td>
										<td>{cache.builds.map(q => q.major + (q.minor ? "." + q.minor : "")).join(",")}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</React.Fragment>
			)}
		</React.Fragment>
	)
}

export class CacheSelector extends React.Component<{ onOpen: (c: SavedCacheSource) => void, noReopen?: boolean }, { lastFolderOpen: FileSystemDirectoryHandle | null }>{
	constructor(p) {
		super(p);
		this.state = {
			lastFolderOpen: null
		};

		if (!this.props.noReopen) {
			datastore.get<FileSystemDirectoryHandle>("lastfolderopen").then(f => {
				if (f) { this.setState({ lastFolderOpen: f }); }
			});
		}
	}

	componentDidMount() {
		document.body.addEventListener("dragover", this.onDragOver);
		document.body.addEventListener("drop", this.onFileDrop);
	}

	componentWillUnmount() {
		document.body.removeEventListener("dragover", this.onDragOver);
		document.body.removeEventListener("drop", this.onFileDrop)
	}

	@boundMethod
	onDragOver(e: DragEvent) {
		e.preventDefault();
	}

	@boundMethod
	async clickOpen() {
		let dir = await showDirectoryPicker();
		this.props.onOpen({ type: "sqlitehandle", handle: dir });
	}

	@boundMethod
	async clickOpenNative() {
		if (!electron) { return; }
		let dir: electronType.OpenDialogReturnValue = await electron.ipcRenderer.invoke("openfolder", "%programdata%/jagex/runescape/");
		if (!dir.canceled) {
			this.props.onOpen({ type: "sqlitenodejs", location: dir.filePaths[0] });
		}
	}

	@boundMethod
	async clickOpenLive() {
		this.props.onOpen({ type: "live" });
	}

	@boundMethod
	async clickReopen() {
		if (!this.state.lastFolderOpen) { return; }
		if (await this.state.lastFolderOpen.requestPermission() == "granted") {
			this.props.onOpen({ type: "sqlitehandle", handle: this.state.lastFolderOpen });
		}
	}

	@boundMethod
	async onFileDrop(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) {
			let files: Record<string, Blob> = {};
			let items: DataTransferItem[] = [];
			let folderhandles: FileSystemDirectoryHandle[] = [];
			let filehandles: FileSystemFileHandle[] = [];
			for (let i = 0; i < e.dataTransfer.items.length; i++) { items.push(e.dataTransfer.items[i]); }
			//needs to start synchronously as the list is cleared after the event stack
			await Promise.all(items.map(async item => {
				if (item.getAsFileSystemHandle) {
					let filehandle = (await item.getAsFileSystemHandle())!;
					if (filehandle.kind == "file") {
						let file = filehandle as FileSystemFileHandle;
						filehandles.push(file);
						files[filehandle.name] = await file.getFile();
					} else {
						let dir = filehandle as FileSystemDirectoryHandle;
						folderhandles.push(dir);
						for await (let handle of dir.values()) {
							if (handle.kind == "file") {
								files[handle.name] = await handle.getFile();
							}
						}
					}
				} else if (item.kind == "file") {
					let file = item.getAsFile()!;
					files[file.name] = file;
				}
			}));
			if (folderhandles.length == 1 && filehandles.length == 0) {
				console.log("stored folder " + folderhandles[0].name);
				datastore.set("lastfolderopen", folderhandles[0]);
				this.props.onOpen({ type: "sqlitehandle", handle: folderhandles[0] });
			} else {
				console.log(`added ${Object.keys(files).length} files`);
				this.props.onOpen({ type: "sqliteblobs", blobs: files });
			}
		}
	}

	@boundMethod
	openOpenrs2Cache(cachename: number) {
		this.props.onOpen({ type: "openrs2", cachename: cachename + "" });
	}

	render() {
		return (
			<React.Fragment>
				{electron && (
					<React.Fragment>
						<h2>Native local RS3 cache</h2>
						<p>Only works when running in electron</p>
						<input type="button" className="sub-btn" onClick={this.clickOpenNative} value="Open native cache" />
					</React.Fragment>
				)}
				{electron && (
					<React.Fragment>
						<h2>Jagex Servers</h2>
						<p>Download directly from content servers. Only works when running in electron</p>
						<input type="button" className="sub-btn" onClick={this.clickOpenLive} value="Stream from Jagex" />
					</React.Fragment>
				)}
				<h2>Local Cache</h2>
				<CacheDragNDropHelp />
				{!this.props.noReopen && this.state.lastFolderOpen && <input type="button" className="sub-btn" onClick={this.clickReopen} value={`Reopen ${this.state.lastFolderOpen.name}`} />}
				<h2>Historical caches</h2>
				<p>Enter any valid cache id from <a target="_blank" href="https://archive.openrs2.org/">OpenRS2</a>. Entering 0 will load the latest RS3 cache, negative values will load previous caches.</p>
				<OpenRs2IdSelector initialid={0} onSelect={this.openOpenrs2Cache} />
			</React.Fragment>
		);
	}
}

function CacheDragNDropHelp() {
	const canfsapi = typeof FileSystemHandle != "undefined"
	let [open, setOpen] = React.useState(false);
	let [mode, setmode] = React.useState<"fsapi" | "blob">(canfsapi ? "fsapi" : "blob");

	return (
		<React.Fragment>
			<p>
				{canfsapi && "Drag a folder containing the RS3 cache files here in order to view it."}
				{!canfsapi && "Drag the RS3 cache files you wish to view"}
				<a style={{ float: "right" }} onClick={e => setOpen(!open)}>{!open ? "More info" : "Close"}</a>
			</p>
			{open && (
				<div style={{ display: "flex", flexDirection: "column" }}>
					<TabStrip value={mode} tabs={{ fsapi: "Full folder", blob: "Files" }} onChange={setmode as any} />
					{mode == "fsapi" && (
						<React.Fragment>
							{!canfsapi && <p className="mv-errortext">You browser does not support full folder loading!</p>}
							<p>Drop the RuneScape folder into this window.</p>
							<input type="text" onFocus={e => e.target.select()} readOnly value={"C:\\ProgramData\\Jagex"} />
							<video src={new URL("../assets/dragndrop.mp4", import.meta.url).href} autoPlay loop style={{ aspectRatio: "352/292" }} />
						</React.Fragment>
					)}
					{mode == "blob" && (
						<React.Fragment>
							<p>Drop and drop the cache files into this window.</p>
							<input type="text" onFocus={e => e.target.select()} readOnly value={"C:\\ProgramData\\Jagex"} />
							<video src={new URL("../assets/dragndropblob.mp4", import.meta.url).href} autoPlay loop style={{ aspectRatio: "458/380" }} />
						</React.Fragment>
					)}
				</div>
			)}
		</React.Fragment>
	);
}

export type UIContextReady = UIContext & { source: CacheFileSource, sceneCache: ThreejsSceneCache, renderer: ThreeJsRenderer };

//i should figure out this redux thing...
export class UIContext extends TypedEmitter<{ openfile: UIScriptFile | null, statechange: undefined }>{
	source: CacheFileSource | null;
	sceneCache: ThreejsSceneCache | null;
	renderer: ThreeJsRenderer | null;
	rootElement: HTMLElement;
	useServiceWorker: boolean;

	constructor(rootelement: HTMLElement, useServiceWorker: boolean) {
		super();
		this.rootElement = rootelement;
		this.useServiceWorker = useServiceWorker;

		if (useServiceWorker) {
			//this service worker holds a reference to the cache fs handle which will keep the handles valid 
			//across tab reloads
			navigator.serviceWorker.register(new URL('../assets/contextholder.js', import.meta.url).href, { scope: './', });
		}
	}

	setCacheSource(source: CacheFileSource | null) {
		this.source = source;
		this.emit("statechange", undefined)
	}

	setSceneCache(sceneCache: ThreejsSceneCache | null) {
		this.sceneCache = sceneCache;
		this.emit("statechange", undefined)
	}

	setRenderer(renderer: ThreeJsRenderer | null) {
		this.renderer = renderer;
		this.emit("statechange", undefined);
	}

	canRender(): this is UIContextReady {
		return !!this.source && !!this.sceneCache && !!this.renderer;
	}


	@boundMethod
	openFile(file: UIScriptFile | null) {
		this.emit("openfile", file);
	}
}


export async function openSavedCache(source: SavedCacheSource, remember: boolean) {
	let handle: FileSystemDirectoryHandle | null = null;
	let cache: CacheFileSource | null = null;
	if (source.type == "sqliteblobs" || source.type == "sqlitehandle") {
		let files: Record<string, Blob> = {};
		if (source.type == "sqlitehandle") {
			handle = source.handle;
			if (await source.handle.queryPermission() != "granted") {
				console.log("tried to open cache without permission");
				return null;
			}
			// await source.handle.requestPermission();
			for await (let handle of source.handle.values()) {
				if (handle.kind == "file") {
					files[handle.name] = await handle.getFile();
				}
			}
			navigator.serviceWorker.ready.then(q => q.active?.postMessage({ type: "sethandle", handle }));
		} else {
			files = source.blobs;
		}

		cache = new WasmGameCacheLoader();
		(cache as WasmGameCacheLoader).giveBlobs(files);
	}
	if (source.type == "openrs2") {
		cache = new Openrs2CacheSource(source.cachename);
	}
	if (electron && source.type == "sqlitenodejs") {
		cache = new GameCacheLoader(source.location);
	}
	if (source.type == "live") {
		cache = new Downloader();
	}
	if (remember) {
		datastore.set("openedcache", source);
	}
	return cache;
}


function bufToHexView(buf: Buffer) {
	let resulthex = "";
	let resultchrs = "";

	let linesize = 16;
	let groupsize = 8;

	outer: for (let lineindex = 0; ; lineindex += linesize) {
		if (lineindex != 0) {
			resulthex += "\n";
			resultchrs += "\n";
		}
		for (let groupindex = 0; groupindex < linesize; groupindex += groupsize) {
			if (groupindex != 0) {
				resulthex += "  ";
				resultchrs += " ";
			}
			for (let chrindex = 0; chrindex < groupsize; chrindex++) {
				let i = lineindex + groupindex + chrindex;
				if (i >= buf.length) { break outer; }
				let byte = buf[i];

				if (chrindex != 0) { resulthex += " "; }
				resulthex += byte.toString(16).padStart(2, "0");
				resultchrs += (byte < 0x20 ? "." : String.fromCharCode(byte));
			}
		}
	}
	return { resulthex, resultchrs };
}

function TrivialHexViewer(p: { data: Buffer }) {
	let { resulthex, resultchrs } = bufToHexView(p.data);
	return (
		<table>
			<tbody>
				<tr>
					<td style={{ whiteSpace: "pre", userSelect: "text", fontFamily: "monospace" }}>{resulthex}</td>
					<td style={{ whiteSpace: "pre", userSelect: "text", fontFamily: "monospace" }}>{resultchrs}</td>
				</tr>
			</tbody>
		</table>
	)
}

function FileDecodeErrorViewer(p: { file: string }) {
	let err: DecodeErrorJson = JSON.parse(p.file);
	let remainder = Buffer.from(err.remainder, "hex");
	let remainderhex = bufToHexView(remainder);
	return (
		<div style={{ whiteSpace: "pre", userSelect: "text", fontFamily: "monospace" }}>
			{err.error}
			<div>Chunks</div>
			<table>
				<tbody>
					{err.chunks.map((q, i) => {
						let hexview = bufToHexView(Buffer.from(q.bytes, "hex"));
						return (
							<tr key={q.offset + "-" + i}>
								<td>{hexview.resulthex}</td>
								<td>{hexview.resultchrs}</td>
								<td>{q.text}</td>
							</tr>
						);
					})}
					<tr>
						<td>{remainderhex.resulthex}</td>
						<td>{remainderhex.resultchrs}</td>
						<td>remainder: {remainder.byteLength}</td>
					</tr>
				</tbody>
			</table>
			<div>State</div>
			{prettyJson(err.state)}
		</div>
	);
}

function SimpleTextViewer(p: { file: string }) {
	return (
		<div style={{ whiteSpace: "pre", userSelect: "text", fontFamily: "monospace" }}>
			{p.file}
		</div>
	);
}

export function FileViewer(p: { file: UIScriptFile, onSelectFile: (f: UIScriptFile | null) => void }) {
	let el: React.ReactNode = null;
	let filedata = p.file.data;
	let cnvref = React.useRef<HTMLCanvasElement | null>(null);
	if (typeof filedata == "string") {
		if (p.file.name.endsWith(".hexerr.json")) {
			el = <FileDecodeErrorViewer file={filedata} />;
		} else {
			el = <SimpleTextViewer file={filedata} />;
		}
	} else {
		if (p.file.name.match(/\.rstex$/)) {
			let tex = new ParsedTexture(filedata, false, false);
			cnvref.current ??= document.createElement("canvas");
			const cnv = cnvref.current;
			tex.toWebgl().then(img => drawTexture(cnv.getContext("2d")!, img));
			el = <CanvasView canvas={cnvref.current} />;
		} else {
			el = <TrivialHexViewer data={filedata} />
		}
	}

	return (
		<div style={{ display: "grid", gridTemplateRows: "auto 1fr" }}>
			<div className="mv-modal-head">
				<span>{p.file.name}</span>
				<span style={{ float: "right" }} onClick={e => p.onSelectFile(null)}>x</span>
			</div>
			<div style={{ overflow: "auto", flex: "1" }}>
				{el}
			</div>
		</div>
	);
}

