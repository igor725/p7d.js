import P7Dump from "../p7d.js";
import { argv } from "process";
import { printf } from "fast-printf";
import { spawn } from 'child_process';
import fetch from "node-fetch";
import fs from 'fs';

const p7d = new P7Dump();

p7d.on('error', ((p7e) => {
	console.error(p7e.toString());
}));

p7d.on('format', (str, ...args) => {
	str = str.replace(/(%[0-9]*)l*x/g, '$1x');
	return printf(str, ...args);
});

const _tparse = (data) => {
	console.log('Hostname:', data.getHostName());
	console.log('Process:', data.getProcessName());
	console.log('Strings: ', data.getLinesCount());

	const labels = [];
	const searchers = {
		'userland-thread': (str) => str.indexOf('Needs library libSceUlt') !== -1,
		'features-audio': (str) => str.indexOf('Needs library libSceNgs2') !== -1,
		'engine-unity': (str) => (str.indexOf('Il2CppUserAssemblies.prx') !== -1) || (str.indexOf('MonoAssembliesPS4.prx') !== -1),
		'engine-gamemaker': (str) => (str.indexOf('YoYo Games PS4 Runner') !== -1),
		'guest-exception': (str, verb) => verb > 3 &&
			(
				(str.indexOf('Exception 0x') !== -1) ||
				(str.indexOf('Exception: reason') !== -1) ||
				(str.indexOf('Access violation: ') !== -1)
			),
		'shader-gen': (str) => str.indexOf('Couldn\'t generate shader') !== -1,
		'allocator': (str) => (str.indexOf('VirtualProtect() failed') !== -1) || (str.indexOf('CommitError|') !== -1),
		'homebrew': (str) => (str.indexOf('] TITLE_ID| size:') !== -1) && (str.indexOf('(string):CUSA') == -1)
	};
	const loggers = [
		(str) => str.indexOf('Vulkan device: ') !== -1
	];

	for (let i = 0; i < data.getLinesCount(); ++i) {
		const { string, verbosityNum: verb, function: func } = data.renderEx(i);
		for (let i = 0; i < loggers.length; ++i) {
			if (loggers[i] !== null && loggers[i](string, verb)) {
				console[verb > 3 ? 'error' : 'log'](string);
				loggers[i] = null;
				break;
			}
		}

		for (const [id, func] of Object.entries(searchers)) {
			if (func !== null && func(string, verb)) {
				labels.push(id);
				searchers[id] = null;
				break;
			}
		}
	}

	console.log('Labels:', labels);
};

const parseWeb = (url) => fetch(url, {
	redirect: 'follow',
	follow: 16
}).then((res) => {
	if (res.status === 200) {
		switch (res.headers.get('Content-Type')) {
			case 'application/zip':
			case 'application/gzip':
			case 'application/x-zip':
			case 'application/vnd.rar':
			case 'application/x-zip-compressed':
				return res.arrayBuffer().then(async (buf) => {
					const tempFile = `./.tmp${Date.now()}`; // Sigh, Windows
					fs.writeFileSync(tempFile, new Uint8Array(buf));
					const zproc = spawn('7z', ['e', '-so', tempFile]);
					zproc.stdout.setEncoding('binary');
					zproc.stderr.pipe(process.stderr);
					return p7d.parseReadable(zproc.stdout).finally(() => fs.unlinkSync(tempFile));
				});

			case 'application/octet-stream':
				return res.arrayBuffer().then(async (buf) => p7d.parse(Buffer.from(buf)));
		}
	}
});

{
	let path;
	if (path = argv[2]) {
		const parser = () => {
			if (path.startsWith('http://') || path.startsWith('https://')) {
				return parseWeb(path);
			}

			return p7d.parseFile(path);
		}

		parser().then(_tparse).catch((err) => {
			console.error(err.toString());
			process.exit(1);
		});
	} else {
		console.log(
			'Usage:\n\tOpening p7d file from web: node example/main.js http://path.to/your/file[.p7d|.p7d.zip]\n' +
			'\tOpening local p7d file: node example/main.js C:\\path\\to\\your\\file.p7d'
		);
	}
}
