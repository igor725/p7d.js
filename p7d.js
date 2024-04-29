import fs from 'fs/promises';

const P7D_HDR = 5031273339032906918n;
const P7D_HDR_BE = 11974213706116289093n;
const P7D_LEVELS = [
	'trace', 'debug',
	'info', 'warn',
	'err', 'crit',
];

class SeqBuffer {
	constructor(buf, off = 0, parent = null) {
		this.buf = buf;
		this.offset = off;
		this.parent = parent;
	};

	toString(enc) {
		return this.buf.toString(enc);
	};

	zerostring(enc = 'utf-16le', buf = this) {
		let epos = buf.offset;
		if (enc == 'ascii') while (buf.peek_uint8(epos) != 0) epos += 1;
		else while (buf.peek_uint16(epos) != 0) epos += 2;

		const ret = buf.subarray(epos).toString(enc);
		buf.offset = epos + (enc == 'ascii' ? 1 : 2);

		return ret;
	};

	fixedstring(size, enc = 'utf-16le') {
		const ret = this.zerostring(enc, this.subarray(this.offset + size));
		this.offset += size;
		return ret;
	}

	uint64() {
		const ret = this.buf.readBigUInt64LE(this.offset);
		this.offset += 8;
		return ret;
	};

	uint32() {
		const ret = this.buf.readUint32LE(this.offset);
		this.offset += 4;
		return ret;
	};

	peek_uint32(pos = this.offset) {
		return this.buf.readUint32LE(pos);
	};

	uint16() {
		const ret = this.buf.readUint16LE(this.offset);
		this.offset += 2;
		return ret;
	};

	peek_uint16(pos = this.offset) {
		return this.buf.readUint16LE(pos);
	};

	uint8() {
		return this.buf.readUint8(this.offset++);
	};

	peek_uint8(pos = this.offset) {
		return this.buf.readUint8(pos);
	}

	skip(count) {
		this.offset += count;
		return this.offset;
	};

	left() {
		return this.buf.length - this.offset;
	};

	tell(absolute = false) {
		if (absolute && this.parent !== null)
			return this.parent.tell(true) + this.offset;
		return this.offset;
	};

	subarray(endpos) {
		return new SeqBuffer(this.buf.subarray(this.offset, endpos), 0, this);
	};

	finish() {
		return this.offset = this.buf.length;
	}
};

class SeqBufferBE extends SeqBuffer {
	uint64() {
		const ret = this.buf.readBigUInt64BE(this.offset);
		this.offset += 8;
		return ret;
	};

	uint32() {
		const ret = this.buf.readUint32BE(this.offset);
		this.offset += 4;
		return ret;
	};

	peek_uint32(pos = this.offset) {
		return this.buf.readUint32BE(pos);
	};

	uint16() {
		const ret = this.buf.readUint16BE(this.offset);
		this.offset += 2;
		return ret;
	};

	peek_uint16(pos = this.offset) {
		return this.buf.readUint16BE(pos);
	};

	uint8() {
		return this.buf.readUint8(this.offset++);
	};

	subarray(endpos) {
		return new SeqBufferBE(this.buf.subarray(this.offset, endpos), 0, this);
	};
};

export const P7D_ERROR_SUCCESS = 0;
export const P7D_ERROR_INVALID_HEADER = 1;
export const P7D_ERROR_UNKNOWN_TYPE = 2;
export const P7D_ERROR_UNKNOWN_CALLBACK = 3;
export const P7D_ERROR_INVALID_PACKET = 4;
export const P7D_ERROR_READER_FAIL = 5;

export class P7Error {
	constructor(code = P7D_ERROR_SUCCESS, udata = null, data = null) {
		this.code = code;
		this.data = data;
		this.udata = udata;
	};

	toString() {
		switch (this.code) {
			case P7D_ERROR_SUCCESS:
				return 'No errors';
			case P7D_ERROR_INVALID_HEADER:
				return 'Invalid p7d header';
			case P7D_ERROR_UNKNOWN_TYPE: {
				const { type, offset } = this.data;
				return `Unknown formatting type: ${type}, offset(${offset})`;
			}
			case P7D_ERROR_UNKNOWN_CALLBACK: {
				const { type } = this.data;
				return `Unknown callback type: ${type}`;
			}
			case P7D_ERROR_INVALID_PACKET: {
				const { packet, offset, left } = this.data;
				return `Invalid p7d packet: id(${packet}), offset(${offset}), unread(${left})`;
			}
			case P7D_ERROR_READER_FAIL: {
				const { type, offset } = this.data;
				return `Unhandled p7d reader exception at offset(${offset}): ${type}`
			}
		}

		return `Error ${this.code}: ${this.data}`;
	};
};

const emptycallback = () => { };
const emptyformatter = (str) => str;

class P7Data {
	#info = null;
	#fmtcb = null;

	constructor(info = null, fmtcb = emptyformatter) {
		this.#info = info;
		this.#fmtcb = fmtcb;
	};

	getProcessName() {
		return this.#info.processName;
	};

	getProcessId() {
		return this.#info.processID;
	};

	getHostName() {
		return this.#info.hostName;
	};

	getModulesCount() {
		return this.#info.modules.length;
	};

	getModuleId(name) {
		return this.#info.modules.indexOf(name);
	};

	getModuleName(id) {
		return this.#info.modules[id] ?? 'null';
	};

	getLinesCount() {
		return this.#info.data.length;
	};

	getStringById(id) {
		return this.#info.strings.find((str) => str.id === id);
	};

	forEachVerb(test, callback) {
		this.#info.data.forEach((item, index) => {
			if (test(item.verb)) return callback(index);
		});
	};

	render(linenum) {
		const rData = this.#info.data[linenum];
		const _str = this.getStringById(rData.strId);
		if (_str.fmtInfo === null) return _str.data;
		return this.#fmtcb(_str._data, ...rData.values);
	};

	renderEx(linenum) {
		const rData = this.#info.data[linenum];
		const _str = this.getStringById(rData.strId);
		return {
			module: this.getModuleName(_str.modId),
			file: _str.fileName,
			function: _str.funcName,
			line: _str.fileLine,
			threadId: rData.thId,
			verbosityNum: rData.verb,
			verbosity: P7D_LEVELS[rData.verb] ?? 'unknown',
			string: _str.fmtInfo === null ? _str.data : this.#fmtcb(_str.data, ...rData.values)
		};
	};
};

export default class P7Dump {
	#errcb = emptycallback;
	#fmtcb = emptyformatter;

	async parse(buffer, userData = null) {
		let reader = null;
		const header = buffer.readBigUInt64LE();
		if (header === P7D_HDR) {
			reader = new SeqBuffer(buffer, 8);
		} else if (header === P7D_HDR_BE) {
			reader = new SeqBufferBE(buffer, 8);
		} else {
			throw new P7Error(P7D_ERROR_INVALID_HEADER, userData);
		}

		const p7d = {
			userData,
			modules: [],
			strings: [],
			data: []
		};

		p7d.processID = reader.uint32();
		p7d.creationTime = reader.uint64();
		p7d.processName = reader.fixedstring(0x200);
		p7d.hostName = reader.fixedstring(0x200);

		while (reader.left() > 0) {
			const packet = this.#getPacket(reader);
			const data = packet.data;

			while (data.left() > 0) {
				try {
					this.#packetReader(data, p7d);
				} catch (err) {
					if (err instanceof P7Error) {
						this.#errcb(err);
						break;
					}

					this.#errcb(new P7Error(P7D_ERROR_READER_FAIL, userData, { type: err, offset: reader.tell() }));
					break;
				}
			}

			reader.skip(packet.size);
		}

		return new P7Data(p7d, this.#fmtcb);
	};

	async parseFile(path, userData = null) {
		return fs.readFile(path).then((buffer) => this.parse(buffer, userData));
	};

	async #readableWrapper(read) {
		return new Promise((resolve, reject) => {
			const bufs = [];
			read.on('data', (data) => {
				bufs.push(Uint8Array.from(Array.from(data).map(char => char.charCodeAt(0))));
			});
			read.on('error', (err) => reject(err));
			read.on('end', () => {
				resolve(Buffer.concat(bufs));
			});
		});
	};

	async parseReadable(read, userData = null) {
		return this.parse(await this.#readableWrapper(read), userData);
	};

	on(type, callback = null) {
		callback = callback ?? emptycallback;

		switch (type) {
			case 'error':
				this.#errcb = callback;
				break;

			case 'format':
				this.#fmtcb = callback;
				break;

			default: {
				throw new P7Error(P7D_ERROR_UNKNOWN_CALLBACK, null, { type: type });
			} break;
		}
	};

	#getPacket(reader) {
		const packetInfo = reader.peek_uint32();
		const packet = {
			channel: packetInfo & 0x1F000000,
			size: packetInfo & 0xE0FFFFFF
		};

		packet.data = reader.subarray(reader.tell() + packet.size);
		packet.data.skip(4);

		return packet;
	};

	#packetReader(data, p7d) {
		let pNum;

		switch (pNum = data.uint8()) {
			case 0x00: { // Stream info
				data.skip(35); // todo: figure out the rest data
				p7d.streamName = data.fixedstring(128);
			} break;
			case 0xE0: {
				data.skip(3);
				const modId = data.uint16();
				data.skip(4);
				const modName = data.fixedstring(0x36, 'ascii');
				p7d.modules[modId] = modName;
			} break;
			case 0x20: { // New string
				data.skip(2);
				const strId = data.uint16();
				data.skip(1);
				const fileLine = data.uint16();
				const modId = data.uint16();
				const numFmt = data.uint16();
				let fmtInfo = null;

				if (numFmt > 0) {
					fmtInfo = [];
					for (let i = 0; i < numFmt; ++i) {
						const type = data.uint8();
						const size = data.uint8();
						fmtInfo[i] = { type, size };
					}
				}

				const string = data.zerostring();
				const fileName = data.zerostring('ascii');
				const funcName = data.zerostring('ascii');

				p7d.strings.push({
					id: strId, modId, data: string,
					fmtInfo, fileName, fileLine, funcName
				});
			} break;
			case 0x40: { // Construct string
				data.skip(2);
				const strId = data.uint16();
				data.skip(1);
				const verb = data.uint8();
				data.skip(1);
				const thId = data.uint32();
				data.skip(12);
				let values = null;

				const { fmtInfo } = p7d.strings.find((str) => str.id == strId);

				if (fmtInfo != null) {
					values = [];

					for (const item of fmtInfo) {
						switch (item.type) {
							case 1: { // Looks like invalid data
								values.push(null);
							} break;
							case 4: {
								values.push(data.uint32());
								data.skip(4);
							} break;
							case 5: {
								if (item.size != 8)
									throw new P7Error(P7D_ERROR_INVALID_FMT_SIZE, p7d.userData, { offset: data.tell(true), type: item.type, size: item.size });
								values.push(data.uint64());
							} break;
							case 8: {
								values.push(data.zerostring());
							} break;
							case 9: {
								values.push(data.zerostring('ascii'));
							} break;
							default: {
								throw new P7Error(P7D_ERROR_UNKNOWN_TYPE, p7d.userData, { offset: data.tell(true), type: item.type });
							} break;
						}
					}
				}

				p7d.data.push({ strId, thId, verb, values });
				data.finish(); // todo: figure out the rest data
			} break;
			case 0x60: { // Some unknown packet
				data.finish();
			} break;
			case 0x80: { // Finishing packet?
				data.finish(); // todo: figure out the rest data
			} break;

			default: {
				throw new P7Error(P7D_ERROR_INVALID_PACKET, p7d.userData, { packet: pNum, offset: data.tell(true), left: data.left() });
			} break;
		}
	};
};
