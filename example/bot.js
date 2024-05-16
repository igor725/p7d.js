import P7Dump from "../p7d.js";
import http from "node:http";
import { printf } from "fast-printf";
import { spawn } from 'child_process';
import fetch from "node-fetch";
import fs from 'fs';

const ISSUE_TITLE_REGEX =
	/^\[\w{4}\d{5}\]\:\s.+$/;
const ISSUE_BODY_LOG_SEARCH =
	/(https\:\/\/github.com\/SysRay\/psOff_compatibility\/files\/\d+\/.+\.(?:zip|rar|7z|gz))/g;

const p7d = new P7Dump();

p7d.on('error', ((p7e) => {
	console.error(p7e.toString());
}));

p7d.on('format', (str, ...args) => {
	str = str.replace(/(%[0-9]*)l*x/g, '$1x');
	return printf(str, ...args);
});

const _tparse = (data) => {
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

	for (let i = 0; i < data.getLinesCount(); ++i) {
		const { string, verbosityNum: verb, function: func } = data.renderEx(i);

		for (const [id, func] of Object.entries(searchers)) {
			if (func !== null && func(string, verb)) {
				labels.push(id);
				searchers[id] = null;
				break;
			}
		}
	}

	return labels;
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

const secret = 'psoff_p7d_bot_secret';

const server = http.createServer((req, res) => {
	if (req.headers['content-type'] !== 'application/json') {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end('{"error": "Not a JSON request"}');
		return;
	} else if (!req.headers['user-agent'] || req.headers['user-agent'].indexOf('GitHub-Hookshot') !== 0) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end('{"error": "Not a GitHub hookshot request"}');
		return;
	}

	const event = req.headers['x-github-event'];

	if (event === 'ping') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('{"message": "Pong!"}');
		return;
	} else if (event !== 'issues') {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end('{"error": "Not a issues event!"}');
		return;
	}

	const jbody = [];

	req.on('readable', () => {
		jbody.push(req.read());
	});

	req.on('end', async () => {
		const jparsed = JSON.parse(jbody.join(''));

		if (jparsed.action === 'opened') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"message": "Done, thank you!"}');

			const issue = jparsed.issue;
			const problems = [];
			const out_labels = [];

			try {
				if (!ISSUE_TITLE_REGEX.test(issue.title)) {
					problems.push(
						'Update the issue\'s title. It should be in the following format: `[XXXX00000]: Application name`'
					);
				}

				if (issue.body === null) {
					problems.push('You should provide information about the game\'s status, do not create empty issues!');
				} else {
					const breg = new RegExp(ISSUE_BODY_LOG_SEARCH);
					let logparsed = false;
					let limit = 8;

					let m;
					while (m = breg.exec(issue.body)) {
						if (limit-- > 0) {
							await parseWeb(m[1]).then(_tparse).then((labels) => {
								m = null; // Stop the further matching
								logparsed = true;
								out_labels.push(...labels);
							}).catch((err) => {
								console.error(`Failed to parse ${m[1]}: ${err.toString()}`);
							});
						} else {
							m = null; // Stop the further matching
						}
					}

					if (!logparsed) problems.push('We didn\'t find valid p7d log in your issue, please provide it!');
				}
			} catch (e) {
				problems.push('UNRELATED TO THIS ISSUE: p7d.js bot threw an exception!');
				console.error(e);
			}

			if (problems.length > 0) out_labels.push('invalid');
			console.log(out_labels, problems);
			// todo: octokit, push info
		} else {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"message": "Event ignored"}');
		}
	});
});

server.listen(7924);
