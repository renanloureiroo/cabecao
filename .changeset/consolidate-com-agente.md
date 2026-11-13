---
"cabecao": minor
---

Consolidação com um agente e suporte ao Antigravity: `cabecao consolidate --run` chama o Claude Code ou o Codex (com chave de API) sem ninguém olhando, só com as tools do Cabeção (shell, edição de arquivos e rede negados), numa pasta temporária e com tempo limite, e desfaz o que o agente gravou se ele não fechar a consolidação; `cabecao install-client antigravity` registra o servidor no Antigravity, e o `gemini` passa a avisar que o Gemini CLI deixou de atender contas pessoais.
