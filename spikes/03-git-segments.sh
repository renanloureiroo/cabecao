#!/usr/bin/env bash
# Spike 3: derivados em SEGMENTOS IMUTÁVEIS numa branch órfã. Duas máquinas, sem merge driver.
set -euo pipefail
W=$(mktemp -d); cd "$W"; export GIT_AUTHOR_NAME=s GIT_AUTHOR_EMAIL=s@s GIT_COMMITTER_NAME=s GIT_COMMITTER_EMAIL=s@s
q() { git "$@" >/dev/null 2>&1; }
seg() { # cria um segmento imutável com N vetores int8 de 384d (bytes aleatórios = pior caso de compressão)
  local dir=$1 n=$2 f; f=$(mktemp); head -c $((n*416)) /dev/urandom > "$f"
  local h; h=$(shasum -a 256 "$f" | cut -c1-16); mv "$f" "$dir/embeddings/seg-$h.bin"; }
git init -q --bare remote.git
git clone -q remote.git A 2>/dev/null; cd A; git checkout -q --orphan cabecao/index; mkdir embeddings; seg . 100
git add -A; q commit -m init; q push -u origin cabecao/index; cd ..
git clone -q -b cabecao/index remote.git B

echo "== 1. escritas concorrentes (A e B criam segmentos ao mesmo tempo)"
(cd A; seg . 50; git add -A; q commit -m a1; q push)
(cd B; seg . 70; git add -A; q commit -m b1; if git push -q 2>/dev/null; then echo "push direto"; else q pull --rebase && q push && echo "B: push rejeitado -> pull --rebase -> OK, sem conflito"; fi)
(cd A; q pull --rebase; echo "A vê $(/bin/ls embeddings | wc -l | tr -d ' ') segmentos")

echo "== 2. compactação concorrente (as duas máquinas compactam os MESMOS segmentos)"
compact() { local d=$1; cat "$d"/embeddings/seg-*.bin > "$d/all.tmp"; git -C "$d" rm -q embeddings/seg-*.bin; mkdir -p "$d/embeddings"; local h; h=$(shasum -a 256 "$d/all.tmp" | cut -c1-16); mv "$d/all.tmp" "$d/embeddings/seg-$h.bin"; git -C "$d" add -A; q -C "$d" commit -m compact; }
(cd B; q pull --rebase); compact A; (cd B; seg . 10; git add -A; q commit -m b2); compact B
(cd A; q push)
(cd B; if q pull --rebase; then q push; echo "B: rebase após compactação dupla -> OK, sem conflito ($(/bin/ls embeddings | wc -l | tr -d ' ') segmentos; duplicatas saem na próxima compactação)"; else echo "CONFLITO"; git status --short; fi)

echo "== 3. crescimento: 180 syncs (60 vetores cada) + compactação a cada 30"
cd A; q pull --rebase
for i in $(seq 1 180); do seg . 60; git add -A; q commit -m "s$i"; if (( i % 30 == 0 )); then compact .; fi; done
q push; q gc --aggressive --prune=now
live=$(du -sk embeddings | cut -f1); hist=$(du -sk .git | cut -f1)
echo "dados vivos: ${live}KB | .git com histórico completo: ${hist}KB"

echo "== 4. achatar o histórico (1 commit) + force push; B se recupera?"
tree=$(git write-tree); c=$(git commit-tree "$tree" -m "index snapshot"); q reset --hard "$c"; q push --force-with-lease
q reflog expire --expire=now --all; q gc --aggressive --prune=now
echo ".git após achatar: $(du -sk .git | cut -f1)KB"
cd ../B; seg . 20; git add -A; q commit -m "b-local-nao-enviado"
mine=$(git diff --name-only --diff-filter=A '@{u}'..HEAD)
q fetch; if git merge-base --is-ancestor '@{u}' HEAD 2>/dev/null || git merge-base HEAD '@{u}' >/dev/null 2>&1; then echo "históricos relacionados"; else
  mkdir -p ../keep; for f in $mine; do cp "$f" ../keep/; done
  q reset --hard '@{u}'; cp ../keep/* embeddings/; git add -A; q commit -m "b reaplica segmentos locais"; q push
  echo "B: detectou histórico achatado -> reset + reaplicou $(echo "$mine" | wc -l | tr -d ' ') segmento local -> push OK"; fi
rm -rf "$W"
