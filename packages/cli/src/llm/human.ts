// Ativar ou trocar o provedor de respostas, apagar uma chave e gastar com o provedor (`llm test`, `eval --answers`) é
// ação do USUÁRIO no terminal (decisão 38). A regra de quem é quem é a da CLI (`../actor.ts` e `../access.ts`): o
// roteador já recusa `llm on|off|test|remove` para um agente, com o código 4. Esta função é a segunda trava, no próprio
// comando, para o caso de o comando ser chamado por outro caminho (como o `eval --answers`, que é de administração).
import { CliError } from '../errors.ts';
import type { CommandContext } from '../types.ts';

export type HumanIo = Pick<CommandContext, 'env'> & { prompt: NonNullable<CommandContext['prompt']> };

/** Lança `human_only` (código 4) se quem roda não é o usuário num terminal. `action` começa a frase. */
export function requireHuman(ctx: Pick<CommandContext, 'env' | 'prompt' | 'actor'>, action: string): HumanIo {
  if (ctx.actor.actor !== 'human' || ctx.prompt === undefined) {
    throw new CliError(`${action} é com você, no seu terminal: ${ctx.actor.explanation}`, {
      code: 'human_only',
      hint: 'Rode no seu terminal. Um agente não ativa, não troca, não testa e não lê a chave do provedor de respostas.',
    });
  }
  return { env: ctx.env, prompt: ctx.prompt };
}
