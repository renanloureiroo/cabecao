# Roda um comando num pseudo-terminal de verdade (o terminal CONTROLADOR do processo) e responde a uma pergunta.
# Usado por `pty.test.ts`; só a biblioteca padrão do Python, sem dependência.
#
#   python3 pty-driver.py <texto que espera> <resposta> <comando> [args...]
#
# Escreve no stdout um JSON com a saída do terminal e o código de saída do comando.
import json
import os
import pty
import select
import sys
import time

expect, answer, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

out = b""
answered = False
deadline = time.time() + 60
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.2)
    if master in ready:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        if not answered and expect.encode() in out:
            answered = True
            os.write(master, (answer + "\r").encode())
    else:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8
print(json.dumps({"code": code, "answered": answered, "output": out.decode("utf-8", "replace")}))
