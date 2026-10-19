#!/usr/bin/env python3
"""Build a throwaway, branchy copy of this repository for the landing-page screenshots.

The real history of Lanes is linear. This script replays the real commits (same file changes, same author and
dates) into a new repository, grouping some of them onto feature branches that are merged back with --no-ff,
so the commit graph shows several coloured lines. It then adds a bare "origin", a tag and a few uncommitted
changes. Nothing is written to the source repository.

Usage: make_repo.py <dest-dir> <ko|en>
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, '..', '..'))

# Public, non-personal identity for every replayed commit.
AUTHOR_NAME = 'flashrifle'
AUTHOR_EMAIL = 'info@j-lab.site'

# Short subjects for the Korean set where the original wording names third-party marks.
KO_OVERRIDES = {
    'f37e253': 'feat: vcs-log 그래프 엔진 포팅 (일반 + Bek 정렬)',
    'c57275f': 'fix(graph): 시작점 정렬 순서를 맞춰 Bek이 머지된 브랜치를 끼워 넣도록 수정',
    'cba6a3e': 'chore: 이름을 Lanes로 변경, NOTICE와 README 추가',
    '8acfde0': 'docs: 상표 고지 추가',
}

# Branch plan: (branch name, [short hashes in order]); everything else goes straight onto main.
# Each block is contiguous in the real sequence, so after each merge main holds exactly a prefix of the real
# history (the merge tree is the real tree of the block's last commit).
BRANCHES = [
    ('feature/file-history', ['94fac88', 'ffc602d']),
    ('feature/branch-highlight', ['b50c4b5']),
    ('feature/write-ops-ui', ['01605df', '9f732c2']),
    ('feature/local-changes', ['db2859e', '08890f2']),
    ('feature/backend-write-ops', ['a3e0052', '2db48bb']),
    ('feature/action-bar', ['d81284f', '1ae08e1', '5312b6f', 'c428294']),
    ('fix/review-backend', ['d67c3c2']),
    ('fix/review-ui', ['e29d527']),
    ('feature/undo-commit', ['52d3417']),
    ('release/0.1.0', ['2036d71', '8c02855']),
]
# Blocks that fork from the same main commit and are merged one after another (parallel lanes).
FORK_GROUPS = [
    ['feature/branch-highlight', 'feature/write-ops-ui', 'feature/local-changes', 'feature/backend-write-ops'],
    ['fix/review-backend', 'fix/review-ui', 'feature/undo-commit'],
]
KEEP_BRANCHES = ['feature/undo-commit', 'release/0.1.0', 'fix/review-ui']
TAG = ('v0.1.0', '8c02855')
# origin/main stops at this many commits behind local main
LOCAL_AHEAD = 2


def git(repo, *args, env=None, inp=None):
    e = dict(os.environ)
    e.update({'GIT_CONFIG_NOSYSTEM': '1', 'LC_ALL': 'C'})
    if env:
        e.update(env)
    r = subprocess.run(['git', '-C', repo, *args], capture_output=True, env=e, input=inp)
    if r.returncode != 0:
        raise SystemExit(f'git {" ".join(args)} failed:\n{r.stderr.decode()}')
    return r.stdout.decode('utf-8', 'replace')


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ('ko', 'en'):
        raise SystemExit(__doc__)
    dest, lang = os.path.abspath(sys.argv[1]), sys.argv[2]
    en = json.load(open(os.path.join(HERE, 'messages_en.json'), encoding='utf-8'))

    # the real linear history, oldest first
    log = git(SRC, 'log', '--reverse', '--first-parent', '--format=%H%x1f%h%x1f%at%x1f%ct%x1f%B%x1e', 'main')
    commits = []
    for rec in log.split('\x1e'):
        rec = rec.strip('\n')
        if not rec:
            continue
        h, short, at, ct, msg = rec.split('\x1f', 4)
        msg = '\n'.join(l for l in msg.strip().split('\n') if not l.startswith('Co-Authored-By:')).strip()
        if lang == 'en' and short in en:
            msg = en[short]
        elif lang == 'ko' and short in KO_OVERRIDES:
            body = msg.split('\n', 1)[1].strip() if '\n' in msg else ''
            body = '\n'.join(l for l in body.split('\n') if 'IntelliJ' not in l and 'JetBrains' not in l).strip()
            msg = KO_OVERRIDES[short] + ('\n\n' + body if body else '')
        commits.append({'hash': h, 'short': short, 'at': int(at), 'ct': int(ct), 'msg': msg})
    by_short = {c['short']: c for c in commits}

    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    work = os.path.join(dest, 'Lanes')
    origin = os.path.join(dest, 'origin.git')
    subprocess.run(['git', 'init', '-q', '-b', 'main', work], check=True)
    git(work, 'config', 'user.name', AUTHOR_NAME)
    git(work, 'config', 'user.email', AUTHOR_EMAIL)
    git(work, 'config', 'commit.gpgsign', 'false')
    # objects come from the source repo (read-only alternate, copied by repack below)
    with open(os.path.join(work, '.git', 'objects', 'info', 'alternates'), 'w') as f:
        f.write(os.path.join(SRC, '.git', 'objects') + '\n')

    index = os.path.join(dest, 'tmp-index')
    ienv = {'GIT_INDEX_FILE': index}

    def tree_of(rev):
        return git(work, 'rev-parse', rev + '^{tree}').strip()

    def overlay(parent_tree, c):
        """parent_tree + the files commit `c` changed (its versions), as a new tree."""
        if os.path.exists(index):
            os.remove(index)
        git(work, 'read-tree', parent_tree, env=ienv)
        changed = git(work, 'diff-tree', '-r', '--no-commit-id', '--no-renames', '-z', '--name-status',
                      c['hash'] + '^' if c is not commits[0] else '4b825dc642cb6eb9a060e54bf8d69288fbee4904', c['hash'])
        toks = [t for t in changed.split('\0') if t]
        for st, path in zip(toks[0::2], toks[1::2]):
            if st.startswith('D'):
                git(work, 'update-index', '--force-remove', '--', path, env=ienv)
            else:
                mode, _typ, blob = git(work, 'ls-tree', c['hash'], '--', path).split('\t')[0].split()
                git(work, 'update-index', '--add', '--cacheinfo', f'{mode},{blob},{path}', env=ienv)
        return git(work, 'write-tree', env=ienv).strip()

    def commit_tree(tree, parents, msg, at, ct):
        env = {
            'GIT_AUTHOR_NAME': AUTHOR_NAME, 'GIT_AUTHOR_EMAIL': AUTHOR_EMAIL, 'GIT_AUTHOR_DATE': f'{at} +0900',
            'GIT_COMMITTER_NAME': AUTHOR_NAME, 'GIT_COMMITTER_EMAIL': AUTHOR_EMAIL, 'GIT_COMMITTER_DATE': f'{ct} +0900',
        }
        args = ['commit-tree', tree]
        for p in parents:
            args += ['-p', p]
        return git(work, *args, env=env, inp=msg.encode('utf-8')).strip()

    branch_of = {}
    for name, shorts in BRANCHES:
        for s in shorts:
            branch_of[s] = name
    blocks = dict(BRANCHES)
    group_of = {b: g for g in FORK_GROUPS for b in g}
    fork_point = {}
    main_tip = None
    tips = {}
    new_of = {}
    last_t = 0
    i = 0
    while i < len(commits):
        c = commits[i]
        name = branch_of.get(c['short'])
        if not name:
            parent_tree = tree_of(main_tip) if main_tip else '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
            main_tip = commit_tree(overlay(parent_tree, c), [main_tip] if main_tip else [], c['msg'], c['at'], c['ct'])
            new_of[c['short']] = main_tip
            last_t = c['ct']
            i += 1
            continue
        # a whole block: fork, replay, merge
        shorts = blocks[name]
        group = group_of.get(name)
        base = fork_point.setdefault(tuple(group), main_tip) if group else main_tip
        tip = base
        for s in shorts:
            bc = by_short[s]
            tip = commit_tree(overlay(tree_of(tip), bc), [tip], bc['msg'], bc['at'], bc['ct'])
            new_of[s] = tip
            last_t = bc['ct']
        tips[name] = tip
        last = by_short[shorts[-1]]
        mt = last_t + 180
        merge_msg = f"Merge branch '{name}'"
        main_tip = commit_tree(tree_of(last['hash']), [main_tip, tip], merge_msg, mt, mt)
        last_t = mt
        i += len(shorts)

    git(work, 'update-ref', 'refs/heads/main', main_tip)
    for name in KEEP_BRANCHES:
        git(work, 'update-ref', f'refs/heads/{name}', tips[name])
    tag_target = new_of[TAG[1]]
    tag_env = {'GIT_COMMITTER_NAME': AUTHOR_NAME, 'GIT_COMMITTER_EMAIL': AUTHOR_EMAIL,
               'GIT_COMMITTER_DATE': f"{by_short[TAG[1]]['ct'] + 60} +0900"}
    git(work, 'tag', '-a', TAG[0], '-m', 'Lanes 0.1.0', tag_target, env=tag_env)

    # self-contained objects, then drop the alternate
    git(work, 'repack', '-a', '-d', '-q')
    os.remove(os.path.join(work, '.git', 'objects', 'info', 'alternates'))
    if os.path.exists(index):
        os.remove(index)

    # origin: main a couple of commits behind, plus the kept branches
    subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', origin], check=True)
    git(work, 'remote', 'add', 'origin', origin)
    git(work, 'push', '-q', 'origin', f'main~{LOCAL_AHEAD}:refs/heads/main', 'release/0.1.0', 'feature/undo-commit', 'v0.1.0')
    git(work, 'fetch', '-q', 'origin')
    git(work, 'branch', '-q', '--set-upstream-to=origin/main', 'main')
    git(work, 'branch', '-q', '--set-upstream-to=origin/release/0.1.0', 'release/0.1.0')
    git(work, 'branch', '-q', '--set-upstream-to=origin/feature/undo-commit', 'feature/undo-commit')
    git(work, 'reset', '-q', '--hard', 'main')

    # uncommitted changes: one staged, one unstaged, two untracked
    def edit(path, find, add):
        p = os.path.join(work, path)
        s = open(p, encoding='utf-8').read()
        assert find in s, (path, find)
        open(p, 'w', encoding='utf-8').write(s.replace(find, find + add, 1))
    if lang == 'ko':
        edit('README.md', '무료이며 오픈소스(Apache-2.0)입니다.\n', '\n웹사이트: https://flashrifle.github.io/Lanes/\n')
        edit('docs/releases/v0.1.0.md', '### 설치\n', '- 홈페이지: https://flashrifle.github.io/Lanes/\n')
    else:
        edit('README.md', '무료이며 오픈소스(Apache-2.0)입니다.\n', '\nWebsite: https://flashrifle.github.io/Lanes/\n')
        edit('docs/releases/v0.1.0.md', '### 설치\n', '- Homepage: https://flashrifle.github.io/Lanes/\n')
    git(work, 'add', 'README.md')
    os.makedirs(os.path.join(work, 'site'), exist_ok=True)
    open(os.path.join(work, 'site', 'index.html'), 'w').write(
        '<!doctype html>\n<html lang="ko">\n<head>\n  <meta charset="utf-8">\n  <title>Lanes</title>\n'
        '  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Lanes</h1>\n</body>\n</html>\n')
    open(os.path.join(work, 'site', 'style.css'), 'w').write(
        ':root { --bg: #14161D; --text: #E8EAF2; --accent: #4C8DFF; }\nbody { background: var(--bg); color: var(--text); }\n')
    print(work)


if __name__ == '__main__':
    main()
