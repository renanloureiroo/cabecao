// Próximos passos OPCIONAIS, detectados e nunca perguntados (decisão 04: instalar só com a URL, sem assistente). O
// `init` termina com até três deles; o `status` e o `doctor` repetem os que continuam pendentes. Cada um traz o
// comando que o usuário roda quando quiser.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readBrainConfig, readLocalEmbeddingState } from '@cabecao/core';
import { runtimeStatus } from '@cabecao/embeddings';
import { homeDir, machineConfigDir } from './brain.ts';
import { embeddingsCacheDir, fakeEmbedderOn } from './embeddings.ts';
import { CLIENTS, type Location } from './install-client/clients.ts';
import { claudePlugin, pluginActive } from './install-client/plugin.ts';
import { detectClients } from './install-client/register.ts';
import { channel } from './install-method.ts';
import { readScheduleState } from './schedule/system.ts';
import { readRegistry } from './skills/install.ts';
import type { SkillClientId } from './skills/targets.ts';
import { isSkillClient } from './skills/targets.ts';
import { fill, words } from './text.ts';
import type { CliIo } from './types.ts';

export type OptionalId = 'skills' | 'schedule' | 'embeddings' | 'obsidian';

export interface OptionalStep {
  id: OptionalId;
  /** O comando, pronto para copiar. */
  command: string;
  /** O que ele faz, em uma linha. */
  why: string;
}

/** O que a detecção precisa saber (coletado por `gatherOptional`; os testes montam à mão). */
export interface OptionalFacts {
  /** Agentes detectados que leem skills e ainda não as têm do Cabeção. */
  skillClients: SkillClientId[];
  /** O cérebro tem remoto (sem remoto, não há o que sincronizar). */
  hasRemote: boolean;
  scheduleOn: boolean;
  /** O plugin do Claude Code, que já sincroniza no fim de cada sessão. */
  pluginActive: boolean;
  /** Rodando de uma instalação estável (o agendamento recusa o npx). */
  stableInstall: boolean;
  /** `off`: desligada no cérebro; `missing-here`: ligada no cérebro e falta nesta máquina; `on`: em uso aqui. */
  embeddings: 'off' | 'missing-here' | 'on';
  embeddingsModel: string | null;
  /** O cérebro tem `.obsidian/` e o `cabecao obsidian setup` ainda não rodou aqui. */
  obsidian: boolean;
}

/** `A`, `A e B`, `A, B e C`. */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`;
}

/** Até `max` opcionais pendentes, na ordem de utilidade. */
export function optionalSteps(facts: OptionalFacts, max = 3): OptionalStep[] {
  const steps: OptionalStep[] = [];
  if (facts.skillClients.length > 0) {
    steps.push({
      id: 'skills',
      command: 'cabecao install-skills',
      why: `ensina ${listText(facts.skillClients.map((id) => CLIENTS[id].label))} a usar o cérebro pela linha de comando (skills)`,
    });
  }
  if (facts.hasRemote && !facts.scheduleOn) {
    steps.push({
      id: 'schedule',
      command: 'cabecao schedule on',
      why: `${
        facts.pluginActive
          ? 'sincroniza sozinho a cada 30 min (o plugin do Claude Code já sincroniza no fim da sessão; isto cobre os outros agentes)'
          : 'sincroniza sozinho a cada 30 min; sem isso, o que o agente grava só vai às outras máquinas com "cabecao sync"'
      }${facts.stableInstall ? '' : `. Precisa do Cabeção instalado: "npm i -g cabecao@${channel()}"`}`,
    });
  }
  if (facts.embeddings === 'missing-here') {
    steps.push({
      id: 'embeddings',
      command: 'cabecao embeddings on',
      why: `este cérebro usa busca por significado (${facts.embeddingsModel ?? 'modelo do .cabecao.json'}): ligue nesta máquina, com o mesmo modelo`,
    });
  } else if (facts.embeddings === 'off') {
    steps.push({
      id: 'embeddings',
      command: 'cabecao embeddings on',
      why: 'busca por significado, que roda nesta máquina (baixa um runtime e um modelo: centenas de MB)',
    });
  }
  if (facts.obsidian) {
    steps.push({
      id: 'obsidian',
      command: 'cabecao obsidian setup',
      why: 'achei o Obsidian neste cérebro: grafo colorido por tipo, propriedades e painéis',
    });
  }
  return steps.slice(0, max);
}

/** Texto dos opcionais, um por item, com o comando alinhado e a explicação quebrada em `width` colunas. */
export function optionalText(steps: readonly OptionalStep[], prefix = '  ', width = 80): string {
  const column = Math.max(...steps.map((step) => step.command.length));
  const pad = ' '.repeat(prefix.length + column + 2);
  return steps
    .flatMap((step) => fill(words(step.why), width, `${prefix}${step.command.padEnd(column)}  `, pad))
    .join('\n');
}

export type OptionalIo = Pick<CliIo, 'env' | 'platform' | 'homedir' | 'exec' | 'stderr' | 'binPath'>;

/** Coleta os fatos dos opcionais. Nunca lança: o que não der para ler fica de fora. */
export async function gatherOptional(
  io: OptionalIo,
  root: string,
  extra: { hasRemote: boolean; stableInstall: boolean },
): Promise<OptionalFacts> {
  const location: Location = { platform: io.platform, env: io.env, home: homeDir(io) };
  const facts: OptionalFacts = {
    skillClients: [],
    hasRemote: extra.hasRemote,
    scheduleOn: false,
    pluginActive: false,
    stableInstall: extra.stableInstall,
    embeddings: 'on',
    embeddingsModel: null,
    obsidian: false,
  };
  try {
    const detected = (await detectClients(io, location)).filter(isSkillClient);
    const registry = await readRegistry(machineConfigDir(io));
    const covered = new Set(registry.installs.filter((i) => i.scope === 'user').flatMap((i) => i.clients));
    facts.pluginActive = pluginActive(await claudePlugin(location));
    // com o plugin, o Claude Code já sabe usar o cérebro (servidor e skill do plugin)
    facts.skillClients = detected.filter((id) => !covered.has(id) && !(id === 'claude-code' && facts.pluginActive));
  } catch {
    facts.skillClients = [];
  }
  try {
    facts.scheduleOn = (await readScheduleState(io)) !== null;
  } catch {
    facts.scheduleOn = true; // não deu para ler: não sugere
  }
  try {
    const config = await readBrainConfig(root);
    if (config.embedding === undefined) facts.embeddings = 'off';
    else {
      facts.embeddingsModel = config.embedding.model;
      const local = await readLocalEmbeddingState(root);
      if (!local.disabled && !fakeEmbedderOn(io)) {
        const runtime = await runtimeStatus({ cacheDir: embeddingsCacheDir(io) });
        if (!runtime.installed) facts.embeddings = 'missing-here';
      }
    }
  } catch {
    facts.embeddings = 'on';
  }
  facts.obsidian = existsSync(join(root, '.obsidian')) && !existsSync(join(root, '.cabecao', 'obsidian-setup.json'));
  return facts;
}
