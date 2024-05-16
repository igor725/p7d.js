import P7Dump from "../p7d.js";
import http from "node:http";
import { printf } from "fast-printf";
import { spawn } from 'child_process';
import { Octokit } from "octokit";
import fetch from "node-fetch";
import fs from 'fs';

const ISSUE_TITLE_REGEX =
	/^\[\w{4}\d{5}\]\:\s.+$/;
const ISSUE_BODY_LOG_SEARCH =
	/(https\:\/\/github.com\/SysRay\/psOff_compatibility\/files\/\d+\/.+\.(?:zip|rar|7z|gz))/g;
const SFO_TITLE_ID =
	/^Read\s\.sfo\sparam\[\d*\]\sTITLE_ID\|\ssize:\d*\svalue\(string\):(.+)/;

const p7d = new P7Dump();
const ok = new Octokit({
	auth: process.env.GITHUB_TOKEN
});

p7d.on('error', ((p7e) => {
	console.error(p7e.toString());
}));

p7d.on('format', (str, ...args) => {
	str = str.replace(/(%[0-9]*)l*x/g, '$1x');
	return printf(str, ...args);
});

const _tparse = (data) => {
	let titleId = null;
	const labels = [];
	const searchers = {
		'userland-thread': ({ string }) => string.indexOf('Needs library libSceUlt') !== -1,
		'features-audio': ({ string }) => string.indexOf('Needs library libSceNgs2') !== -1,
		'engine-unity': ({ string: str }) => (str.indexOf('Il2CppUserAssemblies.prx') !== -1) || (str.indexOf('MonoAssembliesPS4.prx') !== -1),
		'engine-gamemaker': ({ string }) => (string.indexOf('YoYo Games PS4 Runner') !== -1),
		'guest-exception': ({ verbosityNum: verb, string: str }) => verb > 3 &&
			(
				(str.indexOf('Exception 0x') !== -1) ||
				(str.indexOf('Exception: reason') !== -1) ||
				(str.indexOf('Access violation: ') !== -1)
			),
		'shader-gen': ({ string }) => string.indexOf('Couldn\'t generate shader') !== -1,
		'allocator': ({ string: str }) => (str.indexOf('VirtualProtect() failed') !== -1) || (str.indexOf('CommitError|') !== -1),
		'homebrew': ({ string: str }) => (str.indexOf('] TITLE_ID| size:') !== -1) && (str.indexOf('(string):CUSA') == -1)
	};

	for (let i = 0; i < data.getLinesCount(); ++i) {
		// const { string, verbosityNum: verb, function: func, module } = data.renderEx(i);
		const rendered = data.renderEx(i);

		if (rendered.module === 'SYSTEMCONTENT') {
			const m = rendered.string.match(SFO_TITLE_ID);
			if (m) titleId = m[1];
		}

		for (const [id, func] of Object.entries(searchers)) {
			if (func !== null && func(rendered)) {
				labels.push(id);
				searchers[id] = null;
				break;
			}
		}
	}

	return { titleId, labels };
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

const getFileLinks = (data, limit = 8) => {
	const breg = new RegExp(ISSUE_BODY_LOG_SEARCH);
	const links = [];

	let m;
	while (m = breg.exec(data)) {
		if (limit-- == 0) break;
		links.push(m[1]);
	}

	return links;
};

const shouldKeepLabel = (label) =>
	label.startsWith('status-') ||
	label.startsWith('engine-');

const testIssue = async (issue, changes = null) => {
	const problems = [];
	const out_labels = [];

	for (let i = 0; i < issue.labels; ++i) {
		if (shouldKeepLabel(issue[i])) out_labels.push(issue[i]);
	}

	try {
		if (!ISSUE_TITLE_REGEX.test(issue.title)) {
			problems.push(
				'Update the issue\'s title. It should be in the following format: `[XXXX00000]: Application name`'
			);
		}

		if (issue.body === null) {
			problems.push('You should provide information about the game\'s status, do not create empty issues!');
		} else {
			const oldlinks = changes && changes.body ? getFileLinks(changes.body.from) : null;
			const newlinks = getFileLinks(issue.body);
			let logparsed = false;

			for (let i = 0; !logparsed && i < newlinks.length; ++i) {
				if (oldlinks && oldlinks.indexOf(newlinks[i]) !== -1) {
					logparsed = true;
					break;
				}

				const url = newlinks[i];
				await parseWeb(url).then(_tparse).then(({ titleId, labels }) => {
					if (!titleId || issue.title.startsWith(`[${titleId}]`))
						out_labels.push(...labels.filter((lab) => out_labels.indexOf(lab) === -1));
					else
						problems.push('This log-file is most likely created by another game, please upload the valid one');
					logparsed = true;
				}).catch((err) => {
					console.error(`Failed to parse ${url}: ${err.toString()}`);
				});
			}

			if (!logparsed)
				problems.push('We didn\'t find valid p7d log in your issue, please provide it!');
		}
	} catch (e) {
		problems.push('UNRELATED TO THIS ISSUE: p7d.js bot threw an exception!');
		console.error(e);
	}

	if (problems.length > 0) out_labels.push('invalid');

	return { labels: out_labels, problems };
};

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

	const sayWeFineToGitHub = (handled = true) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(`{"message": "${handled ? 'Done, thank you!' : 'Event ignored'}"}`);
	};

	const jbody = [];

	req.on('readable', () => {
		jbody.push(req.read());
	});

	req.on('end', async () => {
		const jparsed = JSON.parse(jbody.join(''));

		const tryUpdateLabels = (labels) =>
			ok.rest.issues.setLabels({
				owner: jparsed.repository.owner.login,
				repo: jparsed.repository.name,
				issue_number: jparsed.issue.number,
				labels: labels
			}).catch((err) => {
				console.error('Failed to update issue\'s labels:', err.toString());
			});

		const trySendComment = (comment) =>
			ok.rest.issues.createComment({
				owner: jparsed.repository.owner.login,
				repo: jparsed.repository.name,
				issue_number: jparsed.issue.number,
				body: comment.toString()
			});

		const sendProblems = (problems, upddate = null) => {
			if (problems.length === 0) return;

			const commlines = [
				'# This is an automated response based on issue analysis',
			];

			if (upddate) commlines.push(`## This issue was updated at ${upddate}`);

			commlines.push(
				'Problems to be fixed:',
				`\n* ${problems.join(';\n* ')}`
			);
			trySendComment(commlines.join('\n'));
		};

		if (jparsed.action === 'opened') {
			sayWeFineToGitHub();

			const { labels, problems } = await testIssue(jparsed.issue);

			tryUpdateLabels(labels);
			sendProblems(problems);
		} else if (jparsed.action === 'edited') {
			sayWeFineToGitHub();
			if (!jparsed.issue || !jparsed.changes || jparsed.issue.state !== 'open') return;

			const { labels, problems } = await testIssue(jparsed.issue, jparsed.changes);

			tryUpdateLabels(labels);
			sendProblems(problems, jparsed.issue.updated_at);
		} else {
			sayWeFineToGitHub(false);
		}
	});
});

server.listen(7924);
