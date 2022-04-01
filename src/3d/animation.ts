import { Stream, packedHSL2HSL, HSL2RGB } from "./utils";
import { cacheMajors } from "../constants";
import { CacheFileSource } from "../cache";
import { parseFrames, parseFramemaps, parseSequences, parseSkeletalAnim } from "../opdecoder";
import { AnimationClip, Bone, Euler, KeyframeTrack, Matrix3, Matrix4, Object3D, Quaternion, QuaternionKeyframeTrack, Skeleton, Vector3, VectorKeyframeTrack } from "three";
import { skeletalanim } from "../../generated/skeletalanim";
import { framemaps } from "../../generated/framemaps";
import { ThreejsSceneCache } from "./ob3tothree";
import { sequences } from "../../generated/sequences";

//TODO remove
import * as THREE from "three";
(window as any).THREE = THREE;


//test    anim ids
//3577    falling plank
//3567    sawblade
//4013    agi pendulum
//907     wind chimes turning
//28351   pet shop sign
//13655   large orrery
//9101    conveyer belt
//470     ivy shaking
//860     waving flag
//3484    dg door
//114132  weird bugged balloon
//43      fishing spot


//new anims
//115416  obelisk
//114652  pof totem
//117253  dramatic doors

//npc new anims
//27111   butterfly

const framemapCache = new Map<number, ReturnType<typeof parseFramemaps["read"]>>();
let loaded = false;
async function getFramemap(loader: CacheFileSource, id: number) {
	// if (!loaded) {
	// 	let indices = await loader.getIndexFile(cacheMajors.framemaps);
	// 	for (let index of indices) {
	// 		let arch = await loader.getFileArchive(index);
	// 		for (let i = 0; i < index.subindexcount; i++) {
	// 			framemapCache.set(index.minor * 128 + index.subindices[i], parseFramemaps.read(arch[i].buffer));
	// 		}
	// 	}
	// 	loaded = true;
	// }
	// return framemapCache.get(id);
	return loader.getFileById(cacheMajors.framemaps, id);
}


type TransformBase = { type: string, inverse: boolean };
type TransformTranslateConst = TransformBase & { type: "translateconst", data: number[] }
type TransformTranslate = TransformBase & { type: "translate", data: Float32Array }
type TransformRotate = TransformBase & { type: "rotate", data: Float32Array }
type TransformScale = TransformBase & { type: "scale", data: Float32Array }
type Transform = TransformTranslateConst | TransformTranslate | TransformRotate | TransformScale;

export type MountableAnimation = {
	skeleton: Skeleton,
	clip: AnimationClip,
	rootbones: Bone[]
};

export type BoneInit = {
	translateconst: TransformTranslateConst[],
	translate: TransformTranslate[],
	rotate: TransformRotate[],
	scale: TransformScale[],
	children: BoneInit[],
	boneid: number
}
export type ParsedAnimation = {
	rootboneinits: BoneInit[],
	keyframetimes: Float32Array,
	endtime: number
}

function isEqualTr(a: Transform, b: Transform) {
	return a.type == b.type && a.data == b.data && a.inverse == b.inverse;
}

function isInverseTr(a: Transform, b: Transform) {
	return a.type == b.type && a.data == b.data && a.inverse != b.inverse;
}

class TransformStack {
	boneids: number[];
	stack: Transform[] = [];
	constructor(boneids: number[]) {
		this.addTransform({ type: "translateconst", data: boneids, inverse: false });
		this.boneids = boneids;
	}
	cleanStack() {
		while (this.stack.length >= 2 && isInverseTr(this.stack[this.stack.length - 1], this.stack[this.stack.length - 2])) {
			this.stack.splice(this.stack.length - 2, 2);
		}
	}
	addTransform(trans: Transform) {
		this.stack.push(trans);
		this.cleanStack();
	}
	addFromOther(other: Transform[]) {
		for (let i = 0; i < other.length; i++) {
			this.addTransform(other[i]);
		}
	}
	getInverse() {
		let cpy: Transform[] = [];
		for (let i = this.stack.length - 1; i >= 0; i--) {
			cpy.push({ ...this.stack[i], inverse: !this.stack[i].inverse })
		}
		return cpy;
	}
}

function findSharedPivot(bones: TransformStack[]) {
	let len = bones[0].stack.length;
	let passed = true;
	for (let bone of bones) {
		if (bone.stack[0].type != "translateconst") {
			console.log("stack doesn't start with translateconst");
			passed = false;
			break;
		}
	}
	//skip first bone since it's the slightly different translate
	if (passed) {
		outerloop: for (let i = 1; i < len; i++) {
			let tr0 = bones[0].stack[i];
			for (let boneindex = 1; boneindex < bones.length; boneindex++) {
				let tr1 = bones[boneindex].stack[i];
				if (!isEqualTr(tr0, tr1)) {
					console.log("non-equal transform stack")
					passed = false;
					break outerloop;
				}
			}
		}
	}
	if (passed) {
		let ret = new TransformStack(bones.flatMap(q => q.boneids));
		ret.addFromOther(bones[0].stack.slice(1));
		return ret;
	} else {
		console.log("failed bone merge, using longest bone");
		bones.sort((a, b) => a.stack.length - b.stack.length);
		return bones[0];
	}
}


export async function parseSkeletalAnimation(cache: ThreejsSceneCache, animid: number): Promise<MountableAnimation> {
	let anim = parseSkeletalAnim.read(await cache.getFileById(cacheMajors.skeletalAnims, animid));
	let base = parseFramemaps.read(await cache.getFileById(cacheMajors.framemaps, anim.framebase));
	if (!base.skeleton) {
		throw new Error("framebase does not have skeleton");
	}

	let convertedtracks: KeyframeTrack[] = [];

	let animtracks = anim.tracks.sort((a, b) => {
		if (a.boneid != b.boneid) { return a.boneid - b.boneid; }
		return a.type_0to9 - b.type_0to9;
	});

	// console.log(base.skeleton.map(bone => `mats{length(mats)+1}=reshape([${bone.bonematrix.map(q => +q.toFixed(3)).join(",")}],[4,4]);`).join("\n"));


	let sc = (a: number) => +(a).toFixed(2);
	let logmat = (m: Matrix4) => {
		let str = "";
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 4; j++) {
				str += m.elements[i + j * 4].toFixed(2).padStart(7) + (j < 3 ? "," : "");
			}
			str += (i < 3 ? "\n" : "")
		}
		console.log(str);
	}

	let bones: Bone[] = [];
	let binds: Matrix4[] = [];
	let rootbones: Bone[] = [];
	let tmp = new Matrix4();
	let prematrix = new Matrix4().makeScale(1, 1, -1);
	for (let [id, entry] of base.skeleton.entries()) {
		let bone = new Bone();
		let matrix = new Matrix4().fromArray(entry.bonematrix);


		bone.name = "bone_" + id;
		if (entry.nonskinboneid == 65535) {
			rootbones.push(bone);
			matrix.multiply(prematrix);
		} else {
			bones[entry.nonskinboneid].add(bone);
			// matrix.multiply(binds[entry.nonskinboneid]);
		}

		tmp.copy(matrix).decompose(bone.position, bone.quaternion, bone.scale);
		// bone.matrixAutoUpdate = true;
		let angle = new Euler().setFromQuaternion(bone.quaternion);
		console.log(id,
			"TRS", +bone.position.x.toFixed(2), +bone.position.y.toFixed(2), +bone.position.z.toFixed(2),
			// "", sc(angle.x), sc(angle.y), sc(angle.z),
			"",+bone.quaternion.x.toFixed(2), +bone.quaternion.y.toFixed(2), +bone.quaternion.z.toFixed(2),+bone.quaternion.w.toFixed(2),
			"", +bone.scale.x.toFixed(2), +bone.scale.y.toFixed(2), +bone.scale.z.toFixed(2));
		bone.updateMatrixWorld();
		// console.log(id, entry.nonskinboneid);
		// logmat(matrix);
		bones[id] = bone;
		binds[id] = matrix;
	}
	prematrix.invert();
	binds.forEach(q => q.multiply(prematrix));
	let skeleton = new Skeleton(bones);

	let actiontypemap: { t: "unknown" | "rotate" | "translate" | "scale", a: number }[] = [
		{ t: "unknown", a: 0 },

		//1-9
		{ t: "rotate", a: 0 },
		{ t: "rotate", a: 1 },
		{ t: "rotate", a: 2 },
		{ t: "translate", a: 0 },
		{ t: "translate", a: 1 },
		{ t: "translate", a: 2 },
		{ t: "scale", a: 0 },
		{ t: "scale", a: 1 },
		{ t: "scale", a: 2 },

		//10-16 unknown
		{ t: "unknown", a: 0 },
		{ t: "unknown", a: 0 },
		{ t: "unknown", a: 0 },
		{ t: "unknown", a: 0 },
		{ t: "unknown", a: 0 },
		{ t: "unknown", a: 0 },
		{ t: "unknown", a: 0 },
	]


	for (let index = 0; index < animtracks.length;) {
		let track = animtracks[index];

		let xvalues: skeletalanim["tracks"][number]["chunks"] | null = null;
		let yvalues: skeletalanim["tracks"][number]["chunks"] | null = null;
		let zvalues: skeletalanim["tracks"][number]["chunks"] | null = null;

		let tracktype = actiontypemap[track.type_0to9];
		//no clue what these offsets are about
		let boneid = (track.boneid < 16000 ? track.boneid - 64 : track.boneid - 16384);

		while (index < animtracks.length) {
			let track2 = animtracks[index];
			let t2 = actiontypemap[track2.type_0to9];
			if (track2.boneid != track.boneid || t2.t != tracktype.t) { break; }
			if (t2.a == 0) { xvalues = track2.chunks; }
			if (t2.a == 1) { yvalues = track2.chunks; }
			if (t2.a == 2) { zvalues = track2.chunks; }
			index++;
		}

		let bone = bones[boneid];
		if (!bone) {
			console.log("animation track without bone", boneid, track.boneid);
			continue;
		}
		let bonename = bone.name;

		let defaultvalue = (tracktype.t == "scale" ? 1 : 9);
		let intp = (v: { time: number, value: number[] }[] | null, i: number, t: number) => {
			let v1 = v?.[i]?.value[0] ?? defaultvalue;
			let v2 = v?.[i + 1]?.value[0] ?? defaultvalue;
			let t1 = v?.[i]?.time ?? 0;
			let t2 = v?.[i + 1]?.time ?? t1;
			let a = (t1 == t2 ? 0 : (t - t1) / (t2 - t1));
			return v1 * (1 - a) + v2 * a;
		}
		let timearray: number[] = [];
		let data: number[] = [];
		let euler = new Euler();
		let quat = new Quaternion();
		// let time = new Float32Array(timearray.map(q => q * 0.020));
		for (let ix = 0, iy = 0, iz = 0, idata = 0; ;) {
			let tx = xvalues?.[ix]?.time ?? Infinity;
			let ty = yvalues?.[iy]?.time ?? Infinity;
			let tz = zvalues?.[iz]?.time ?? Infinity;

			let t = Math.min(tx, ty, tz);
			if (!isFinite(t)) { break; }

			data[idata++] = intp(xvalues, ix, t);
			data[idata++] = intp(yvalues, iy, t);
			data[idata++] = intp(zvalues, iz, t);

			timearray.push(t);
			if (tx == t) { ix++; }
			if (ty == t) { iy++; }
			if (tz == t) { iz++; }
		}


		let times = new Float32Array(timearray.map(q => q * 0.020));
		if (tracktype.t == "translate") {
			if (boneid == 0) {
				for (let i = 0; i < data.length; i += 3) {
					// data[i + 2] *= -1;
					// data[i + 2] *= -1;
				}
			}
			convertedtracks.push(new VectorKeyframeTrack(`${bonename}.position`, times as any, data));
		}
		if (tracktype.t == "scale") {
			if (boneid == 0) {
				for (let i = 0; i < data.length; i += 3) {
					// data[i + 0] *= -1;
					data[i + 2] *= -1;
				}
			}
			convertedtracks.push(new VectorKeyframeTrack(`${bonename}.scale`, times as any, data));
		}
		if (tracktype.t == "rotate") {
			let prequat = new Quaternion().setFromEuler(new Euler(-Math.PI, 0, -Math.PI));
			let quatdata = new Float32Array(timearray.length * 4);
			for (let i = 0; i * 3 < data.length; i++) {
				euler.set(
					data[i * 3 + 0],
					data[i * 3 + 1],
					data[i * 3 + 2], 'YXZ');
				quat.setFromEuler(euler);
				if (boneid == 0) {
					quat.multiply(prequat);
				}
				//flip the quaternion along the z axis
				// quat.x *= -1;
				// quat.z *= -1;
				quat.toArray(quatdata, i * 4);
			}
			convertedtracks.push(new QuaternionKeyframeTrack(`${bonename}.quaternion`, times as any, quatdata as any));

			console.log(bonename, tracktype.t, +quatdata[0].toFixed(2), +quatdata[1].toFixed(2), +quatdata[2].toFixed(2), +quatdata[3].toFixed(2));
		} else {
			console.log(bonename, tracktype.t, +data[0].toFixed(2), +data[1].toFixed(2), +data[2].toFixed(2));
		}
	}
	//TODO remove
	// convertedtracks = [];
	let clip = new AnimationClip("anim_" + (Math.random() * 1000 | 0), undefined, convertedtracks);


	return { skeleton, clip, rootbones };
}


export async function parseAnimationSequence3(loader: ThreejsSceneCache, sequenceframes: NonNullable<sequences["frames"]>): Promise<ParsedAnimation> {

	let secframe0 = sequenceframes[0];
	if (!secframe0) {
		throw new Error("animation has no frames");
	}

	let framearch = await loader.getArchiveById(cacheMajors.frames, secframe0.frameidhi);

	let frames = framearch.map(file => {
		let framedata = parseFrames.read(file.buffer);
		return {
			flags: framedata.flags,
			animdata: framedata.animdata,
			dataindex: 0,
			baseid: framedata.probably_framemap_id,
			stream: new Stream(Buffer.from(framedata.animdata))
		};
	})

	let framebase = parseFramemaps.read(await loader.getFileById(cacheMajors.framemaps, frames[0].baseid));


	//calculate frame times
	let endtime = 0;
	let keyframetimes = new Float32Array(sequenceframes.length);
	for (let i = 0; i < sequenceframes.length; i++) {
		keyframetimes[i] = endtime;
		endtime += sequenceframes[i].framelength * 0.020;
	}

	let maxbone = Math.max(...framebase.data.flatMap(q => q.data));


	let bones: TransformStack[] = [];
	for (let i = 0; i <= maxbone + 1; i++) {
		bones.push(new TransformStack([i]));
	}

	type RsTransform = { index: number, type: number, data: Float32Array, nodes: number[] };
	let pivot = bones[0];
	let actions: RsTransform[] = [];//TODO remove


	//TODO remove
	if (typeof (window as any).partialanim == "number") {
		framebase.data = framebase.data.slice(0, (window as any).partialanim);
	}

	for (let [index, base] of framebase.data.entries()) {
		if (base.type == 0) {
			if (base.data.length == 0) {
				pivot = new TransformStack([]);
			} else if (base.data.length == 1) {
				pivot = bones[base.data[0] + 1]
			} else {
				pivot = findSharedPivot(base.data.map(q => bones[q + 1]));
				if (!pivot) { throw new Error("no shared pivot found"); }
			}
		}

		let nfields = [3, 3, 4, 3, 3, 4, 3, 3, 3, 3, 3][base.type];
		let rawclip = new Float32Array(nfields * frames.length);
		let clipindex = 0;
		let tempquat = new Quaternion();
		let tempEuler = new Euler();
		for (let frame of frames) {
			let flag = frame?.flags[index] ?? 0;

			//there seems to actually be data here
			if (base.type == 0) {
				rawclip[clipindex++] = (flag & 1 ? readAnimTranslate(frame?.stream) : 0);
				rawclip[clipindex++] = (flag & 2 ? readAnimTranslate(frame?.stream) : 0);
				rawclip[clipindex++] = (flag & 4 ? readAnimTranslate(frame?.stream) : 0);
				if (flag != 0) {
					console.log("type 0 data", flag, [...rawclip.slice(clipindex - 3, clipindex)]);
				}
			}
			//translate
			if (base.type == 1) {
				rawclip[clipindex++] = (flag & 1 ? readAnimFraction(frame?.stream) : 0);
				rawclip[clipindex++] = -(flag & 2 ? readAnimFraction(frame?.stream) : 0);
				rawclip[clipindex++] = (flag & 4 ? readAnimFraction(frame?.stream) : 0);
			}
			//rotate
			if (base.type == 2) {
				let rotx = 0;
				if (flag & 1) {
					let comp1 = readAnimFraction(frame.stream);
					let comp2 = readAnimFraction(frame.stream);
					rotx = Math.atan2(comp1, comp2);
					// console.log(rotx);
				}
				let roty = 0;
				if (flag & 2) {
					let comp1 = readAnimFraction(frame.stream);
					let comp2 = readAnimFraction(frame.stream);
					roty = Math.atan2(comp1, comp2);
					// console.log(rotx);
				}
				let rotz = 0;
				if (flag & 4) {
					let comp1 = readAnimFraction(frame.stream);
					let comp2 = readAnimFraction(frame.stream);
					rotz = Math.atan2(comp1, comp2);
					// console.log(rotx);
				}
				// let rotx = (flag & 1 ? Math.atan2(readAnimFraction(frame.stream), readAnimFraction(frame.stream)) : 0);
				// let roty = (flag & 2 ? Math.atan2(readAnimFraction(frame.stream), readAnimFraction(frame.stream)) : 0);
				// let rotz = (flag & 4 ? Math.atan2(readAnimFraction(frame.stream), readAnimFraction(frame.stream)) : 0);
				tempEuler.set(rotx, roty, rotz, "XYZ");
				tempquat.setFromEuler(tempEuler);
				tempquat.toArray(rawclip, clipindex);
				clipindex += 4;
			}
			//scale?
			if (base.type == 3) {
				// if (flag & 1) {
				// 	let i = frame.stream.scanloc();

				// 	let q1 = readAnimFraction(frame.stream);
				// 	frame.stream.skip(i - frame.stream.scanloc());
				// 	let q2 = readAnimTranslate(frame.stream);
				// 	frame.stream.skip(i - frame.stream.scanloc());
				// 	let q3 = frame.stream.readUShortSmart();
				// 	frame.stream.skip(i - frame.stream.scanloc());
				// 	let q4 = frame.stream.readShortSmart();
				// 	console.log(q1, q2, q3, q4);
				// 	rawclip[clipindex++] = q2 / 128;
				// }
				rawclip[clipindex++] = (flag & 1 ? readAnimFraction(frame.stream) : 128) / 128;
				rawclip[clipindex++] = (flag & 2 ? readAnimFraction(frame.stream) : 128) / 128;
				rawclip[clipindex++] = (flag & 4 ? readAnimFraction(frame.stream) : 128) / 128;
			}
			//others todo
			if (base.type == 5) {
				rawclip[clipindex++] = (flag & 1 ? frame.stream.readUShortSmart() : 0);
				rawclip[clipindex++] = (flag & 2 ? frame.stream.readUShortSmart() : 0);
				rawclip[clipindex++] = (flag & 4 ? frame.stream.readUShortSmart() : 0);
			} else if (base.type >= 4) {
				rawclip[clipindex++] = (flag & 1 ? frame.stream.readUShortSmart() : 0);
				rawclip[clipindex++] = (flag & 2 ? frame.stream.readUShortSmart() : 0);
				rawclip[clipindex++] = (flag & 4 ? frame.stream.readUShortSmart() : 0);
			}
		}

		//need to copy and reorder the clip since the frame might be out of order/reused
		let clip = new Float32Array(nfields * sequenceframes.length);
		for (let i = 0; i < sequenceframes.length; i++) {
			let frameid = framearch.findIndex(q => q.fileid == sequenceframes![i].frameidlow);
			for (let j = 0; j < nfields; j++) {
				clip[i * nfields + j] = rawclip[frameid * nfields + j];
			}
		}

		actions.push({
			index,
			data: clip,
			nodes: base.data.map(q => q + 1),
			type: base.type
		});


		let inverse = pivot.getInverse();
		let forward = pivot.stack.slice();
		for (let boneid of base.data) {
			let stack = bones[boneid + 1];
			if (base.type == 1) {
				stack.addTransform({ type: "translate", data: clip, inverse: false });
			} else if (base.type == 2) {
				stack.addFromOther(inverse);
				stack.addTransform({ type: "rotate", data: clip, inverse: false });
				stack.addFromOther(forward);
			} else if (base.type == 3) {
				stack.addFromOther(inverse);
				stack.addTransform({ type: "scale", data: clip, inverse: false });
				stack.addFromOther(forward);
			}
		}
	}


	frames.forEach((q, i) => {
		let bytes = q.stream.bytesLeft();
		if (bytes != 0) {
			console.warn("ints left in anim decode: " + bytes, i);
			let counts: Record<number, number> = {};
			framebase.data.map((fr, i) => {
				// if ([0, 1, 2, 3].indexOf(fr.type) == -1 && (q.flags[i] ?? 0) != 0) {
				// console.log(fr.type, q.flags[i]);
				counts[fr.type] = (counts[fr.type] ?? 0) + (q.flags[i] ?? 0).toString(2).replaceAll("0", "").length;
				// }
			});
			console.log(counts);
		}
	});
	let buildskeleton = function (bones: Set<TransformStack>, transSkip: number) {
		let children: BoneInit[] = [];
		while (bones.size != 0) {
			let friends = new Set(bones);
			let hadnonconst = false;
			let newskip = transSkip;
			let resultbone: BoneInit = {
				translateconst: [],
				translate: [],
				rotate: [],
				scale: [],
				children: [],
				boneid: -1
			}
			let ownerbone: TransformStack | null = null;
			digloop: for (; !ownerbone; newskip++) {
				let tr: Transform | null = null;

				for (let friend of friends) {
					let actionindex = friend.stack.length - 1 - newskip;
					if (actionindex < 0) {
						debugger;
					}
					if (actionindex == 0) {
						if (!hadnonconst && friends.size > 1) {
							friends.delete(friend);
							continue;
						} else {
							ownerbone = friend;
						}
					}
					if (!tr) {
						tr = friend.stack[actionindex];
						//can only stack transforms into the same bone when in compatible order
						if (tr.type == "translate" && (resultbone.rotate.length != 0 || resultbone.scale.length != 0)) { break digloop }
						if (tr.type == "translateconst" && (resultbone.rotate.length != 0 || resultbone.scale.length != 0)) { break digloop; }
						if (tr.type == "rotate" && resultbone.scale.length != 0) { break digloop; }
					} else {
						let match = isEqualTr(tr, friend.stack[actionindex]);
						if (!match) {
							if (!hadnonconst) {
								friends.delete(friend);
							} else {
								break digloop;
							}
						}
					}
				}

				if (tr) {
					if (tr.type == "translateconst") { resultbone.translateconst.push(tr); }
					if (tr.type == "translate") { resultbone.translate.push(tr); }
					if (tr.type == "rotate") { resultbone.rotate.push(tr); }
					if (tr.type == "scale") { resultbone.scale.push(tr); }

					if (tr.type != "translateconst") { hadnonconst = true; }
				}
			}
			if (resultbone.translateconst.length == 0 && resultbone.translate.length == 0 && resultbone.rotate.length == 0 && resultbone.scale.length == 0) {
				console.log("useless bone");
				debugger;
			}
			friends.forEach(q => bones.delete(q));
			if (ownerbone) {
				if (ownerbone.boneids.length != 1) { throw new Error("ownerbone with id length 1 expected"); }
				resultbone.boneid = ownerbone.boneids[0];
				friends.delete(ownerbone);
			}
			resultbone.children = buildskeleton(friends, newskip);
			children.push(resultbone);
		}
		return children;
	}

	let rootboneinits = buildskeleton(new Set(bones), 0);

	let logboneinit = (bone: BoneInit, indent: number) => {
		let actionmap = (tr: Transform[]) => tr.map(q => actions.find(w => w.data == q.data)?.index + (q.inverse ? "!" : ""));
		let str = "  ".repeat(indent);
		str += (bone.boneid != -1 ? bone.boneid : "x");
		str += ") " + bone.translateconst.map(q => q.data + (q.inverse ? "!" : ""));
		str += " - " + actionmap(bone.translate);
		str += " - " + actionmap(bone.rotate);
		str += " - " + actionmap(bone.scale);
		console.log(str);
		bone.children.forEach(q => logboneinit(q, indent + 1));
	}
	console.log(bones);
	rootboneinits.forEach(q => logboneinit(q, 0));
	console.log(framebase.data.map(q => [q.type, "", ...q.data.map(q => q + 1)]));
	return { rootboneinits, keyframetimes, endtime };
}

function readAnimTranslate(str: Stream) {
	let val = str.readUShortSmart();
	//one more bit seems to be reserved, unclear if this also happens for 1byte values
	return (val > 0x2000 ? val - 0x4000 : val);
}
function readAnimFraction(str: Stream) {
	let byte0 = str.readUByte();
	if ((byte0 & 0x80) == 0) {
		return byte0 - 0x40;
	}
	let byte1 = str.readUByte();
	return (((byte0 & 0x7f) << 8) | byte1) - 0x4000;
}