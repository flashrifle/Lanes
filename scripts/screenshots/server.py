#!/usr/bin/env python3
"""Mock Tauri backend for screenshots.

Serves the harness page (index.html, mock.js, driver.js) and answers POST /invoke {cmd, args} by running git on a
real repository, returning JSON shaped like src/types.ts (the Rust models). Read-only: write commands return a
harmless default. Unknown commands are logged to stderr and answer null.

Usage: server.py --repo <work tree> [--port 1555] [--display-root /Users/dev/Projects]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
REV_INDEX, REV_WORKTREE = 'INDEX', 'WORKTREE'

ARGS = None
REPO = None          # real path
DISPLAY = None       # path shown to the UI
SNAPSHOTS = {}
SNAP_LOCK = threading.Lock()
NEXT_SNAP = [1]
UNKNOWN = set()


class AppError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.payload = {'code': code, 'message': message, 'stderr': None}


def git(*args, ok=(0,), stdin=None):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', LC_ALL='C', GIT_CONFIG_NOSYSTEM='1')
    r = subprocess.run(['git', '-C', REPO, *args], capture_output=True, input=stdin, env=env)
    if r.returncode not in ok:
        raise AppError('gitFailed', r.stderr.decode('utf-8', 'replace').strip())
    return r.stdout.decode('utf-8', 'replace')


def real(p):
    return REPO if p in (DISPLAY, REPO) else p


# ───────────── status letters ─────────────
LETTER = {'A': 'added', 'M': 'modified', 'D': 'deleted', 'R': 'renamed', 'C': 'copied', 'T': 'typeChanged', 'U': 'unmerged'}


def st(letter):
    return LETTER.get(letter[:1], 'unknown')


# ───────────── repo / refs ─────────────
def git_version():
    return subprocess.run(['git', '--version'], capture_output=True, text=True).stdout.split()[-1]


def repo_info():
    return {
        'path': DISPLAY, 'name': os.path.basename(DISPLAY), 'gitDir': DISPLAY + '/.git', 'commonDir': DISPLAY + '/.git',
        'user': {'name': git('config', 'user.name').strip() or None, 'email': git('config', 'user.email').strip() or None},
        'remotes': git('remote').split(), 'gitVersion': git_version(),
    }


def parse_track(s):
    s = s.strip()
    if s == 'gone':
        return 0, 0, True
    a = b = 0
    for part in s.split(','):
        part = part.strip()
        if part.startswith('ahead '):
            a = int(part[6:])
        elif part.startswith('behind '):
            b = int(part[7:])
    return a, b, False


def read_refs():
    head_full = git('symbolic-ref', '-q', 'HEAD', ok=(0, 1)).strip() or None
    head_hash = git('rev-parse', '-q', '--verify', 'HEAD^{commit}', ok=(0, 1)).strip() or None
    head = {
        'detached': head_full is None, 'unborn': head_hash is None,
        'branch': head_full[len('refs/heads/'):] if head_full else None, 'fullName': head_full, 'hash': head_hash,
    }
    out = git('for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)',
              'refs/heads', 'refs/remotes', 'refs/tags')
    refs = []
    if head_hash:
        refs.append(dict(name='HEAD', fullName='HEAD', type='head', hash=head_hash, index=None, remote=None, upstream=None,
                         ahead=None, behind=None, upstreamGone=False, isCurrent=True, isFavorite=False))
    for line in out.splitlines():
        f = line.split('\0')
        if len(f) < 6:
            continue
        full = f[0]
        r = dict(name='', fullName=full, type='tag', hash=f[2] or f[1], index=None, remote=None, upstream=None, ahead=None,
                 behind=None, upstreamGone=False, isCurrent=False, isFavorite=full in ('refs/heads/main', 'refs/heads/master'))
        if full.startswith('refs/heads/'):
            r.update(name=full[11:], type='localBranch', isCurrent=f[5] == '*')
            if f[3]:
                a, b, gone = parse_track(f[4])
                r['upstream'] = f[3]
                if gone:
                    r['upstreamGone'] = True
                else:
                    r.update(ahead=a, behind=b)
        elif full.startswith('refs/remotes/'):
            n = full[13:]
            if n.endswith('/HEAD'):
                continue
            r.update(name=n, type='remoteBranch', remote=n.split('/')[0])
        elif full.startswith('refs/tags/'):
            r['name'] = full[10:]
        else:
            continue
        refs.append(r)
    return {'head': head, 'refs': refs, 'operation': None}


# ───────────── log ─────────────
LOG_FMT = '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%B'


def load_log(scope):
    refs = read_refs()
    revs = scope.get('refs') or ['--branches', '--remotes', '--tags', 'HEAD']
    out = git('log', '-z', '--date-order', LOG_FMT, *revs, '--')
    recs = []
    for rec in out.split('\0'):
        rec = rec.lstrip('\n')
        if not rec:
            continue
        f = rec.split('\x1f', 6)
        if len(f) < 7:
            continue
        recs.append({'hash': f[0], 'parents': f[1].split(), 'an': f[2], 'ae': f[3], 'at': int(f[4]), 'ct': int(f[5]),
                     'msg': f[6].rstrip('\n')})
    idx = {r['hash']: i for i, r in enumerate(recs)}
    for r in refs['refs']:
        r['index'] = idx.get(r['hash'])
    with SNAP_LOCK:
        sid = NEXT_SNAP[0]
        NEXT_SNAP[0] += 1
        SNAPSHOTS[sid] = recs
    hh = refs['head']['hash']
    return {
        'snapshotId': sid, 'repoPath': DISPLAY, 'scope': scope, 'commitCount': len(recs),
        'hashes': [r['hash'] for r in recs],
        'parents': [[idx.get(p, -1) for p in r['parents']] for r in recs],
        'timestamps': [r['ct'] for r in recs], 'refs': refs,
        'headIndex': idx.get(hh) if hh else None, 'truncated': False, 'loadMillis': 38,
    }


def snap(sid):
    s = SNAPSHOTS.get(sid)
    if s is None:
        raise AppError('snapshotExpired', 'snapshot expired')
    return s


def commit_rows(sid, indices):
    s = snap(sid)
    return [{'index': i, 'hash': s[i]['hash'], 'subject': s[i]['msg'].split('\n', 1)[0], 'authorName': s[i]['an'],
             'authorEmail': s[i]['ae'], 'authorTime': s[i]['at'], 'committerTime': s[i]['ct'],
             'parentCount': len(s[i]['parents'])} for i in indices if 0 <= i < len(s)]


def filter_commits(sid, flt):
    s = snap(sid)
    text, users = flt.get('text'), flt.get('users')
    if not text and not users and not flt.get('date') and not flt.get('paths') and not flt.get('revRange'):
        return {'matches': None}
    m = []
    for i, r in enumerate(s):
        ok = True
        if text and text.get('text'):
            t = text['text']
            hay = r['msg']
            ok = (t in hay) if text.get('matchCase') else (t.lower() in hay.lower()) or r['hash'].startswith(t.lower())
        if ok and users:
            who = f"{r['an']} <{r['ae']}>".lower()
            ok = any(u.lower() in who for u in users)
        if ok:
            m.append(i)
    return {'matches': m}


def authors(sid):
    c = {}
    for r in snap(sid):
        k = (r['an'], r['ae'])
        c[k] = c.get(k, 0) + 1
    return [{'name': n, 'email': e, 'commitCount': v} for (n, e), v in sorted(c.items(), key=lambda x: -x[1])]


def commit_details(h):
    out = git('log', '-1', '-z', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', h, '--').rstrip('\0')
    f = out.split('\x1f', 8)
    msg = f[8].rstrip()
    subject, _, body = msg.partition('\n')
    return {'hash': f[0], 'parents': f[1].split(), 'authorName': f[2], 'authorEmail': f[3], 'authorTime': int(f[4]),
            'committerName': f[5], 'committerEmail': f[6], 'committerTime': int(f[7]), 'subject': subject, 'body': body.strip()}


def containing_refs(h):
    out = git('for-each-ref', '--contains', h, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags')
    return [l for l in out.splitlines() if l and not (l.startswith('refs/remotes/') and l.endswith('/HEAD'))]


# ───────────── changes / diff ─────────────
def parse_numstat(text):
    toks = text.split('\0')
    out = {}
    i = 0
    while i < len(toks):
        t = toks[i]
        i += 1
        if not t:
            continue
        f = t.split('\t', 2)
        if len(f) < 3:
            continue
        path = f[2]
        if not path:
            path = toks[i + 1] if i + 1 < len(toks) else ''
            i += 2
        out[path] = (int(f[0]), int(f[1])) if f[0].isdigit() and f[1].isdigit() else None
    return out


def diff_pair(frm, to):
    base = frm or EMPTY_TREE
    ns = git('diff-tree', '-r', '-z', '-M', '--name-status', base, to)
    num = parse_numstat(git('--literal-pathspecs', 'diff', '-z', '--no-textconv', '--no-ext-diff', '-M', '--numstat', base, to))
    toks = [t for t in ns.split('\0') if t]
    files = []
    i = 0
    while i < len(toks):
        s = st(toks[i])
        if s in ('renamed', 'copied'):
            old, path = toks[i + 1], toks[i + 2]
            i += 3
        else:
            old, path = None, toks[i + 1]
            i += 2
        n = num.get(path, 'missing')
        if n == 'missing':
            a = d = None
            binary = False
        elif n is None:
            a = d = None
            binary = True
        else:
            (a, d), binary = n, False
        files.append({'path': path, 'oldPath': old, 'status': s, 'additions': a, 'deletions': d, 'binary': binary,
                      'fromHash': frm, 'toHash': to})
    return sorted(files, key=lambda f: f['path'])


def changed_files(hashes):
    if len(hashes) == 1:
        h = hashes[0]
        parents = git('log', '-1', '--format=%P', h).split()
        return {'mode': 'single', 'isMerge': len(parents) > 1, 'files': diff_pair(parents[0] if parents else None, h)}
    newest, oldest = hashes[0], hashes[-1]
    p = git('log', '-1', '--format=%P', oldest).split()
    return {'mode': 'range', 'isMerge': False, 'files': diff_pair(p[0] if p else None, newest)}


HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')


def parse_unified(text, path, old_path):
    d = {'path': path, 'oldPath': old_path, 'binary': False, 'oldMode': None, 'newMode': None, 'hunks': [], 'truncated': False}
    index_mode = None
    o = n = 0
    for line in text.split('\n'):
        m = HUNK.match(line)
        if m:
            a, b, c, e = int(m[1]), int(m[2] or 1), int(m[3]), int(m[4] or 1)
            o, n = a, c
            d['hunks'].append({'header': line, 'oldStart': a, 'oldLines': b, 'newStart': c, 'newLines': e, 'lines': []})
            continue
        if d['hunks']:
            h = d['hunks'][-1]
            ch = line[:1]
            if ch == '+':
                h['lines'].append({'kind': 'add', 'oldLine': None, 'newLine': n, 'text': line[1:]})
                n += 1
            elif ch == '-':
                h['lines'].append({'kind': 'del', 'oldLine': o, 'newLine': None, 'text': line[1:]})
                o += 1
            elif ch == ' ':
                h['lines'].append({'kind': 'context', 'oldLine': o, 'newLine': n, 'text': line[1:]})
                o += 1
                n += 1
            elif ch == '\\':
                h['lines'].append({'kind': 'noNewline', 'oldLine': None, 'newLine': None, 'text': line[1:].lstrip()})
            elif line == '':
                if o >= h['oldStart'] + h['oldLines'] and n >= h['newStart'] + h['newLines']:
                    continue
                h['lines'].append({'kind': 'context', 'oldLine': o, 'newLine': n, 'text': ''})
                o += 1
                n += 1
            continue
        if line.startswith('old mode '):
            d['oldMode'] = line[9:].strip()
        elif line.startswith('new mode '):
            d['newMode'] = line[9:].strip()
        elif line.startswith('new file mode '):
            d['newMode'] = line[14:].strip()
        elif line.startswith('deleted file mode '):
            d['oldMode'] = line[18:].strip()
        elif line.startswith('index '):
            p = line[6:].split()
            index_mode = p[1] if len(p) > 1 else None
        elif line.startswith('Binary files ') or line.startswith('GIT binary patch'):
            d['binary'] = True
        elif line.startswith('rename from ') and d['oldPath'] is None:
            d['oldPath'] = line[12:]
    if d['oldMode'] is None and d['newMode'] is None:
        d['oldMode'] = d['newMode'] = index_mode
    return d


def head_or_empty(frm):
    if frm is None:
        return EMPTY_TREE
    if frm == 'HEAD':
        return git('rev-parse', '-q', '--verify', 'HEAD^{commit}', ok=(0, 1)).strip() or EMPTY_TREE
    return frm


def file_diff(req):
    ctx = min(req.get('contextLines') or 3, 100000)
    args = ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', f'-U{ctx}']
    ok = (0,)
    frm, to = req.get('fromHash'), req['toHash']
    untracked = False
    if to == REV_INDEX:
        args += ['--cached', head_or_empty(frm)]
    elif to == REV_WORKTREE:
        if frm == REV_INDEX:
            pass
        elif frm in (None, 'HEAD') and not git('--literal-pathspecs', 'ls-files', '--cached', '-z', '--', req['path']):
            untracked = True
            ok = (0, 1)
            args.append('--no-index')
        else:
            args.append(head_or_empty(frm))
    else:
        args += [head_or_empty(frm), to]
    args.append('--')
    if untracked:
        args += ['/dev/null', req['path']]
    else:
        if req.get('oldPath'):
            args.append(req['oldPath'])
        args.append(req['path'])
    return parse_unified(git(*args, ok=ok), req['path'], req.get('oldPath'))


# ───────────── status ─────────────
CONFLICT = {'DD': 'bothDeleted', 'AU': 'addedByUs', 'UD': 'deletedByThem', 'UA': 'addedByThem', 'DU': 'deletedByUs', 'AA': 'bothAdded'}


def status():
    out = git('status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all')
    toks = out.split('\0')
    p = {'headHash': None, 'branch': None, 'upstream': None, 'ahead': None, 'behind': None, 'files': [], 'truncated': False,
         'operation': None}
    letter = lambda c: None if c == '.' else st(c)
    i = 0
    while i < len(toks):
        t = toks[i]
        i += 1
        if not t:
            continue
        if t.startswith('# '):
            h = t[2:]
            if h.startswith('branch.oid '):
                v = h[11:]
                p['headHash'] = None if v == '(initial)' else v
            elif h.startswith('branch.head '):
                v = h[12:]
                p['branch'] = None if v == '(detached)' else v
            elif h.startswith('branch.upstream '):
                p['upstream'] = 'refs/remotes/' + h[16:]
            elif h.startswith('branch.ab '):
                a, b = h[10:].split()
                p['ahead'], p['behind'] = int(a.lstrip('+')), int(b.lstrip('-'))
            continue
        k = t[0]
        if k == '1':
            f = t.split(' ', 8)
            e = dict(path=f[8], oldPath=None, staged=letter(f[1][0]), unstaged=letter(f[1][1]), untracked=False, conflict=None,
                     submodule=f[2].startswith('S'))
        elif k == '2':
            f = t.split(' ', 9)
            orig = toks[i]
            i += 1
            e = dict(path=f[9], oldPath=orig, staged=letter(f[1][0]), unstaged=letter(f[1][1]), untracked=False, conflict=None,
                     submodule=f[2].startswith('S'))
        elif k == 'u':
            f = t.split(' ', 10)
            e = dict(path=f[10], oldPath=None, staged=None, unstaged=None, untracked=False, conflict=CONFLICT.get(f[1], 'bothModified'),
                     submodule=f[2].startswith('S'))
        elif k == '?':
            e = dict(path=t[2:], oldPath=None, staged=None, unstaged=None, untracked=True, conflict=None, submodule=False)
        else:
            continue
        p['files'].append(e)
    p['files'].sort(key=lambda f: f['path'])
    return p


# ───────────── file history / blame ─────────────
def file_history(path, rev):
    out = git('--literal-pathspecs', 'log', '-z', '--follow', '-M', '--no-ext-diff', '--diff-merges=first-parent', '--raw',
              '--numstat', '--max-count=5001', '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s', rev or 'HEAD', '--', path)
    entries = []
    cur = path
    for rec in out.split('\x1e'):
        if not rec.strip():
            continue
        head, _, rest = rec.partition('\0')
        f = head.split('\x1f', 5)
        if len(f) < 6:
            continue
        status_ = None
        epath = None
        old = None
        stats = 'none'
        toks = [t.lstrip('\n') for t in rest.split('\0')]
        toks = [t for t in toks if t]
        j = 0
        while j < len(toks):
            t = toks[j]
            j += 1
            if t.startswith(':'):
                s = st(t.rsplit(' ', 1)[-1])
                if s in ('renamed', 'copied'):
                    old, epath = toks[j], toks[j + 1]
                    j += 2
                else:
                    epath = toks[j]
                    j += 1
                status_ = s
            else:
                n = t.split('\t', 2)
                if len(n) < 3:
                    continue
                if not n[2]:
                    j += 2
                stats = (int(n[0]), int(n[1])) if n[0].isdigit() and n[1].isdigit() else None
        epath = epath or cur
        cur = old or epath
        entries.append({'hash': f[0], 'parents': f[1].split(), 'authorName': f[2], 'authorEmail': f[3], 'authorTime': int(f[4]),
                        'subject': f[5], 'path': epath, 'oldPath': old, 'status': status_ or 'modified',
                        'additions': stats[0] if isinstance(stats, tuple) else None,
                        'deletions': stats[1] if isinstance(stats, tuple) else None, 'binary': stats is None})
    return {'path': path, 'entries': entries, 'truncated': False}


def blame(path, rev):
    out = git('blame', '--porcelain', rev, '--', path)
    infos, order, lines = {}, [], []
    cur = None
    for raw in out.split('\n'):
        if raw.startswith('\t'):
            if cur:
                h, orig = cur
                lines.append({'hash': h, 'origLine': orig, 'origPath': infos[h].get('filename', path), 'text': raw[1:].rstrip('\r')})
                cur = None
            continue
        if cur is None:
            parts = raw.split(' ')
            if len(parts) >= 3 and len(parts[0]) == 40:
                h = parts[0]
                if h not in infos:
                    infos[h] = {}
                    order.append(h)
                cur = (h, int(parts[1]))
            continue
        k, _, v = raw.partition(' ')
        info = infos[cur[0]]
        if k == 'author':
            info['an'] = v
        elif k == 'author-mail':
            info['ae'] = v.strip().strip('<>')
        elif k == 'author-time':
            info['at'] = int(v)
        elif k == 'summary':
            info['s'] = v
        elif k == 'boundary':
            info['b'] = True
        elif k == 'filename':
            info['filename'] = v
    commits = [{'hash': h, 'authorName': infos[h].get('an', ''), 'authorEmail': infos[h].get('ae', ''),
                'authorTime': infos[h].get('at', 0), 'subject': infos[h].get('s', ''), 'boundary': infos[h].get('b', False)}
               for h in order]
    return {'path': path, 'rev': rev, 'lines': lines, 'commits': commits, 'binary': False, 'truncated': False}


# ───────────── misc ─────────────
def repo_summary():
    s = status()
    fetch_head = os.path.join(REPO, '.git', 'FETCH_HEAD')
    return [{'path': DISPLAY, 'name': os.path.basename(DISPLAY), 'open': True, 'branch': s['branch'], 'headHash': s['headHash'],
             'upstream': s['upstream'], 'ahead': s['ahead'], 'behind': s['behind'], 'changedCount': len(s['files']),
             'stagedCount': sum(1 for f in s['files'] if f['staged']), 'conflictCount': 0, 'operation': None,
             'lastFetch': int(os.path.getmtime(fetch_head)) if os.path.exists(fetch_head) else None, 'error': None}]


SETTINGS = {'language': 'system', 'density': 'comfortable', 'gitPath': None, 'dateFormat': 'relative', 'externalEditor': None,
            'checkForUpdates': True, 'menuBarIcon': True, 'keepRunningInMenuBar': True, 'backgroundFetchMinutes': None}

WRITE_OPS = {'checkout', 'fetch', 'pull', 'create_branch', 'delete_branch', 'stage_files', 'unstage_files', 'discard_files',
             'apply_patch', 'resolve_conflict', 'push', 'stash_save', 'stash_drop', 'reset', 'create_tag', 'delete_tag', 'push_tag'}


def handle(cmd, a):
    if cmd == '__find':
        # harness helper: newest commit whose message contains `text` (all refs)
        return git('log', '--all', '--format=%H', '-F', f"--grep={a['text']}", '-1').strip() or None
    if cmd == 'get_system_locale':
        return a.get('__locale') or 'ko-KR'
    if cmd == 'get_settings' or cmd == 'set_settings':
        return a.get('settings') or SETTINGS
    if cmd == 'get_recent_repos':
        return [{'path': DISPLAY, 'name': os.path.basename(DISPLAY), 'lastOpened': int(time.time()), 'exists': True}]
    if cmd == 'open_repo':
        return repo_info()
    if cmd == 'get_refs':
        return read_refs()
    if cmd == 'load_log':
        return load_log(a['scope'])
    if cmd == 'release_snapshot':
        return None
    if cmd == 'get_commit_rows':
        return commit_rows(a['snapshotId'], a['indices'])
    if cmd == 'filter_commits':
        return filter_commits(a['snapshotId'], a['filter'])
    if cmd == 'get_authors':
        return authors(a['snapshotId'])
    if cmd == 'get_commit_details':
        return commit_details(a['hash'])
    if cmd == 'get_containing_refs':
        return containing_refs(a['hash'])
    if cmd == 'get_signatures':
        return [{'hash': h, 'status': 'none', 'signer': None} for h in a['hashes']]
    if cmd == 'get_changed_files':
        return changed_files(a['hashes'])
    if cmd == 'get_file_diff':
        return file_diff(a['request'])
    if cmd == 'get_status':
        return status()
    if cmd == 'list_stashes':
        return []
    if cmd == 'get_repo_summaries':
        return repo_summary()
    if cmd == 'get_quick_commit_target':
        return DISPLAY
    if cmd == 'get_file_history':
        return file_history(a['path'], a.get('rev'))
    if cmd == 'get_blame':
        return blame(a['path'], a['rev'])
    if cmd == 'list_files':
        return [p for p in git('ls-tree', '-r', '--name-only', '-z', a.get('rev') or 'HEAD').split('\0') if p]
    if cmd == 'compare_refs':
        l, r = git('rev-list', '--left-right', '--count', f"{a['a']}...{a['b']}").split()
        mb = git('merge-base', a['a'], a['b'], ok=(0, 1)).strip() or None
        return {'aOnly': int(l), 'bOnly': int(r), 'mergeBase': mb}
    if cmd == 'get_push_preview':
        s = status()
        out = git('log', '--format=%H%x1f%s%x1f%an%x1f%at', '@{u}..HEAD').splitlines()
        return {'localBranch': s['branch'], 'remotes': git('remote').split(), 'remote': 'origin', 'remoteBranch': s['branch'],
                'upstream': s['upstream'], 'remoteHash': git('rev-parse', '@{u}').strip(),
                'outgoing': [dict(zip(('hash', 'subject', 'authorName', 'authorTime'), l.split('\x1f'))) for l in out],
                'behind': s['behind'] or 0}
    if cmd == 'get_diagnostics':
        return {'appVersion': '0.1.0', 'os': 'macOS 15.1', 'arch': 'aarch64', 'gitVersion': git_version(), 'gitPath': '/usr/bin/git',
                'locale': a.get('__locale')}
    if cmd in ('validate_branch_name', 'validate_tag_name'):
        return {'valid': True, 'exists': False, 'message': None}
    if cmd == 'validate_git_path':
        return {'ok': True, 'path': '/usr/bin/git', 'version': git_version(), 'message': None}
    if cmd in WRITE_OPS:
        return {'message': ''}
    if cmd in ('close_repo', 'check_for_update', 'set_favorite', 'remove_recent_repo', 'open_quick_commit', 'show_main_window',
               'set_quick_commit_busy', 'open_in_editor', 'reveal_in_finder'):
        return None
    if cmd not in UNKNOWN:
        UNKNOWN.add(cmd)
        sys.stderr.write(f'[mock] unknown command: {cmd} {json.dumps(a)[:200]}\n')
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        if self.path != '/invoke':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])) or b'{}')
        cmd, args = body.get('cmd'), body.get('args') or {}
        for k in ('repoPath', 'path'):
            if isinstance(args.get(k), str) and k == 'repoPath':
                args[k] = real(args[k])
        try:
            res, code = handle(cmd, args), 200
        except AppError as e:
            res, code = e.payload, 500
            sys.stderr.write(f'[mock] {cmd} failed: {e}\n')
        except Exception as e:  # noqa: BLE001
            res, code = {'code': 'internal', 'message': str(e), 'stderr': None}, 500
            sys.stderr.write(f'[mock] {cmd} crashed: {e!r}\n')
        data = json.dumps(res).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'POST, GET')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/log'):
            # driver.js reports page errors here (GET /log?msg=...)
            from urllib.parse import parse_qs, urlparse
            sys.stderr.write('[page] ' + parse_qs(urlparse(self.path).query).get('msg', [''])[0] + '\n')
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()


def main():
    global ARGS, REPO, DISPLAY
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('--port', type=int, default=1555)
    ap.add_argument('--display-root', default='/Users/dev/Projects')
    ARGS = ap.parse_args()
    REPO = os.path.abspath(ARGS.repo)
    DISPLAY = ARGS.display_root.rstrip('/') + '/' + os.path.basename(REPO)
    sys.stderr.write(f'[mock] serving {REPO} as {DISPLAY} on http://127.0.0.1:{ARGS.port}\n')
    ThreadingHTTPServer(('127.0.0.1', ARGS.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
