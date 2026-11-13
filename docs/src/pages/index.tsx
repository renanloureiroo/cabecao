import Link from '@docusaurus/Link';
import Translate, { translate } from '@docusaurus/Translate';
import Cabeca from '@site/src/components/Cabeca';
import CopyCommand from '@site/src/components/CopyCommand';
import Diagrama from '@site/src/components/Diagrama';
import Icon from '@site/src/components/Icon';
import Admonition from '@theme/Admonition';
import CodeBlock from '@theme/CodeBlock';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './index.module.css';

const REPO = 'https://github.com/renanloureiroo/cabecao';

// Saídas reais, as mesmas das páginas "Criar ou conectar um cérebro" e "Primeiro uso com um agente".
const INIT_OUTPUT = `$ cabecao init git@github.com:voce/cerebro.git --machine notebook
Pasta do cérebro: ~/cabecao (máquina notebook)

Repositório: Repositório vazio: estrutura do cérebro criada na branch main e enviada para git@github.com:voce/cerebro.git.

Índice local: 0 notas indexadas em 2 ms.

Clientes de IA:
  Claude Code: registrado
    ~/.claude.json: registrado
  Reinicie o cliente para ele enxergar a mudança.`;

const REMEMBER_OUTPUT = `{
  "op": "01M79DRQR9648E1JZ60MF0EBNN",
  "path": "memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md",
  "action": "add",
  "commit": "1af64e1dc48f5627dd086474c571b22326eaa3c0"
}`;

const SEARCH_OUTPUT = `$ cabecao search "testes pagamento"
1 resultado(s) para "testes pagamento", com todos os termos (validade em 2026-11-13):

1. Testes de pagamento precisam do fuso fixo  [gotcha · project:pagamentos]  vigente
   memory/gotchas/testes-de-pagamento-precisam-do-fuso-fixo.md
   Os «testes» do serviço de pagamentos falham perto da meia-noite se o fuso não for fixo. Rode com \`TZ=UTC npm test\`.`;

const CLIENTS = ['Claude Code', 'Claude Desktop', 'Codex', 'Cursor', 'VS Code', 'Gemini CLI'];

function SectionHeader({ kicker, children, id }: { kicker: string; children: ReactNode; id: string }): ReactNode {
  return (
    <header className={styles.sectionHeader}>
      <p className={styles.kicker}>
        <span aria-hidden="true">{'// '}</span>
        {kicker}
      </p>
      <h2 id={id} className={styles.sectionTitle}>
        {children}
      </h2>
    </header>
  );
}

function Hero(): ReactNode {
  return (
    <header className={clsx('tema-escuro', styles.hero)}>
      <div className={clsx('cb-dot-grid', styles.dots)} aria-hidden="true" />
      <div className={styles.heroInner}>
        <div className={styles.heroText}>
          <p className={styles.kicker}>
            <span aria-hidden="true">{'// '}</span>
            <Translate id="home.hero.kicker">memória para agentes de IA</Translate>
          </p>
          <h1 className={styles.heroTitle}>
            <Translate id="home.title">Um segundo cérebro que os seus agentes também leem</Translate>
            <span className={clsx(styles.cursor, 'cb-blink')} aria-hidden="true" />
          </h1>
          <p className={styles.lead}>
            <Translate id="home.tagline">
              {
                'Suas notas ficam em Markdown, num repositório git que é seu. Os agentes de IA consultam e gravam nelas por MCP, e tudo o que eles fazem vira um commit que você desfaz com um comando.'
              }
            </Translate>
          </p>
          <CopyCommand command="npm i -g cabecao@beta" />
          <div className={styles.actions}>
            <Link className={clsx(styles.button, styles.buttonPrimary)} to="/comecar/instalacao/">
              <Translate id="home.cta.start">Começar</Translate>
              <Icon name="arrow" />
            </Link>
            <Link className={clsx(styles.button, styles.buttonSecondary)} href={REPO}>
              <Translate id="home.cta.github">Ver no GitHub</Translate>
            </Link>
          </div>
          <p className={styles.heroMeta}>
            <Translate id="home.hero.meta">
              Node.js 22.16+ ou 24 · git 2.38+ · licença MIT · beta 0.1.0-beta.1
            </Translate>
          </p>
        </div>
        <div className={styles.heroArt}>
          <Cabeca size={384} blink className={styles.heroHead} />
        </div>
      </div>
    </header>
  );
}

interface Idea {
  readonly title: string;
  readonly body: ReactNode;
}

function ideas(): Idea[] {
  return [
    {
      title: translate({ id: 'home.feature.files.title', message: 'Markdown e git seus' }),
      body: (
        <Translate id="home.feature.files.body" values={{ md: <code>.md</code> }}>
          {
            'As notas são arquivos {md} numa pasta comum. Você lê e edita no Obsidian ou em qualquer editor. Não há banco de dados que só o Cabeção entende.'
          }
        </Translate>
      ),
    },
    {
      title: translate({ id: 'home.feature.hosts.title', message: 'Qualquer provedor' }),
      body: (
        <Translate id="home.feature.hosts.body">
          {
            'GitHub, GitLab, Bitbucket, Gitea, um servidor seu ou só a sua máquina. O Cabeção usa o git e as credenciais que você já tem; não depende da API de nenhum provedor.'
          }
        </Translate>
      ),
    },
    {
      title: translate({ id: 'home.feature.mcp.title', message: 'Agentes por MCP' }),
      body: (
        <Translate id="home.feature.mcp.body">
          {
            'Um servidor MCP local entrega aos agentes busca, grafo, fatos com validade no tempo e ferramentas para gravar memórias, com regras que eles não conseguem contornar.'
          }
        </Translate>
      ),
    },
    {
      title: translate({ id: 'home.feature.undo.title', message: 'Tudo reversível' }),
      body: (
        <Translate id="home.feature.undo.body" values={{ undo: <code>cabecao undo</code> }}>
          {
            'Cada gravação é um commit identificado. {undo} desfaz uma operação ou uma sessão inteira de um agente, sem reescrever o histórico.'
          }
        </Translate>
      ),
    },
  ];
}

function Step({
  n,
  title,
  children,
  code,
}: {
  n: number;
  title: string;
  children: ReactNode;
  code: ReactNode;
}): ReactNode {
  return (
    <li className={styles.step}>
      <div className={styles.stepText}>
        <span className={styles.stepNumber} aria-hidden="true">
          {String(n).padStart(2, '0')}
        </span>
        <h3 className={styles.stepTitle}>{title}</h3>
        <p className={styles.stepBody}>{children}</p>
      </div>
      <div className={styles.stepCode}>{code}</div>
    </li>
  );
}

interface Card {
  readonly to: string;
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
}

function cards(): Card[] {
  return [
    {
      to: '/comecar/instalacao/',
      kicker: translate({ id: 'home.cards.guide', message: 'começar' }),
      title: translate({ id: 'home.cards.install.title', message: 'Instalação' }),
      body: translate({
        id: 'home.cards.install.body',
        message: 'Instale o Cabeção pelo npm e confira os requisitos.',
      }),
    },
    {
      to: '/comecar/primeiro-uso/',
      kicker: translate({ id: 'home.cards.guide', message: 'começar' }),
      title: translate({ id: 'home.cards.first.title', message: 'Primeiro uso com um agente' }),
      body: translate({
        id: 'home.cards.first.body',
        message: 'O que pedir ao agente, o que ele grava e como isso aparece na próxima sessão.',
      }),
    },
    {
      to: '/referencia/cli/',
      kicker: translate({ id: 'home.cards.reference', message: 'referência' }),
      title: translate({ id: 'home.cards.cli.title', message: 'CLI' }),
      body: translate({
        id: 'home.cards.cli.body',
        message: 'Todos os comandos do cabecao, com as opções, exemplos e códigos de saída.',
      }),
    },
    {
      to: '/referencia/mcp/',
      kicker: translate({ id: 'home.cards.reference', message: 'referência' }),
      title: translate({ id: 'home.cards.mcp.title', message: 'Servidor MCP' }),
      body: translate({
        id: 'home.cards.mcp.body',
        message: 'As 17 tools, os resources e as instruções do servidor, com o que um agente pode e não pode fazer.',
      }),
    },
  ];
}

export default function Home(): ReactNode {
  return (
    <Layout
      title={translate({ id: 'home.meta.title', message: 'Segundo cérebro em Markdown e git' })}
      description={translate({
        id: 'home.meta.description',
        message: 'Seu segundo cérebro em Markdown e git, para você e seus agentes de IA, servido por MCP.',
      })}
    >
      <Hero />

      <main className={styles.main}>
        <section className={styles.section} aria-labelledby="o-que-e">
          <SectionHeader id="o-que-e" kicker={translate({ id: 'home.what.kicker', message: 'o que é' })}>
            <Translate id="home.what.title">Markdown e git por baixo, MCP por cima</Translate>
          </SectionHeader>
          <ul className={styles.ideas}>
            {ideas().map((idea) => (
              <li key={idea.title} className={styles.idea}>
                <h3 className={styles.ideaTitle}>{idea.title}</h3>
                <p className={styles.ideaBody}>{idea.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="na-pratica">
          <SectionHeader id="na-pratica" kicker={translate({ id: 'home.demo.kicker', message: 'na prática' })}>
            <Translate id="home.demo.title">Do init à próxima sessão</Translate>
          </SectionHeader>
          <ol className={styles.steps}>
            <Step
              n={1}
              title={translate({ id: 'home.demo.init.title', message: 'Crie o cérebro' })}
              code={<CodeBlock language="text">{INIT_OUTPUT}</CodeBlock>}
            >
              <Translate id="home.demo.init.body">
                {
                  'Um comando, sem perguntas: ele cria a estrutura no repositório vazio, monta o índice local e registra o servidor MCP nos clientes de IA que encontrar.'
                }
              </Translate>
            </Step>
            <Step
              n={2}
              title={translate({ id: 'home.demo.remember.title', message: 'O agente lembra' })}
              code={
                <CodeBlock language="json" title="remember">
                  {REMEMBER_OUTPUT}
                </CodeBlock>
              }
            >
              <Translate id="home.demo.remember.body" values={{ tz: <code>TZ=UTC</code> }}>
                {
                  'Numa sessão do Claude Code, você pede "guarde que os testes de pagamento só passam com {tz}". O agente chama a tool remember, e a resposta é uma nota nova e um commit.'
                }
              </Translate>
            </Step>
            <Step
              n={3}
              title={translate({ id: 'home.demo.search.title', message: 'Volta quando precisa' })}
              code={<CodeBlock language="text">{SEARCH_OUTPUT}</CodeBlock>}
            >
              <Translate id="home.demo.search.body">
                {
                  'Na próxima sessão, em qualquer máquina, a nota volta no recall do agente. E também pelo terminal, na busca.'
                }
              </Translate>
            </Step>
          </ol>
        </section>

        <section className={styles.section} aria-labelledby="como-funciona">
          <SectionHeader id="como-funciona" kicker={translate({ id: 'home.how.kicker', message: 'como funciona' })}>
            <Translate id="home.how.title">Arquivos, git e um servidor MCP na sua máquina</Translate>
          </SectionHeader>
          <p className={styles.sectionLead}>
            <Translate id="home.how.body">
              {
                'As notas ficam numa pasta comum, versionada com git. Os agentes leem e gravam por um servidor MCP que roda na sua máquina, e cada gravação vira um commit. O sync leva tudo ao seu repositório e dali às outras máquinas.'
              }
            </Translate>
          </p>
          <div className={styles.diagram}>
            <Diagrama />
          </div>
        </section>

        <section className={clsx(styles.section, styles.audience)} aria-labelledby="para-quem">
          <div>
            <SectionHeader id="para-quem" kicker={translate({ id: 'home.audience.kicker', message: 'para quem é' })}>
              <Translate id="home.audience.title">Para quem trabalha com agentes de IA</Translate>
            </SectionHeader>
            <p className={styles.sectionLead}>
              <Translate id="home.audience.body">
                {
                  'Para quem trabalha com agentes de IA (Claude Code, Codex, Cursor e outros) e cansou de repetir as mesmas preferências, decisões e armadilhas a cada sessão nova. O que você ensina numa conversa fica guardado e volta na próxima, em qualquer cliente e em qualquer máquina.'
                }
              </Translate>
            </p>
            <p className={styles.tagsLabel}>
              <Translate id="home.audience.clients">Clientes que o init registra</Translate>
            </p>
            <ul className={styles.tags}>
              {CLIENTS.map((c) => (
                <li key={c} className={styles.tag}>
                  {c}
                </li>
              ))}
            </ul>
          </div>
          <Admonition type="warning" title={translate({ id: 'home.beta.title', message: 'Versão beta' })}>
            <Translate
              id="home.beta.body"
              values={{
                version: <code>0.1.0-beta.1</code>,
                notes: (
                  <Link to="/novidades/">
                    <Translate id="home.beta.notes">novidades</Translate>
                  </Link>
                ),
              }}
            >
              {
                'O Cabeção está em beta ({version}). Ele já funciona no dia a dia, mas o formato e os comandos ainda podem mudar antes da versão 1.0. Use um repositório privado e confira as {notes} ao atualizar.'
              }
            </Translate>
          </Admonition>
        </section>

        <section className={clsx(styles.section, styles.last)} aria-labelledby="comecar">
          <SectionHeader id="comecar" kicker={translate({ id: 'home.start.kicker', message: 'começar' })}>
            <Translate id="home.quick.title">Em três comandos</Translate>
          </SectionHeader>
          <div className={styles.quick}>
            <div>
              <CodeBlock language="bash">
                {'npm i -g cabecao@beta\ncabecao init git@github.com:voce/cerebro.git\ncabecao doctor'}
              </CodeBlock>
              <p className={styles.quickBody}>
                <Translate
                  id="home.quick.body"
                  values={{
                    init: <code>init</code>,
                    link: (
                      <Link to="/comecar/instalacao/">
                        <Translate id="home.quick.link">Instalação</Translate>
                      </Link>
                    ),
                  }}
                >
                  {
                    'O {init} clona o repositório, cria a estrutura (ou adota o que já existe), monta o índice local e registra o servidor MCP nos clientes de IA que encontrar. O passo a passo está em {link}.'
                  }
                </Translate>
              </p>
            </div>
            <ul className={styles.cards}>
              {cards().map((card) => (
                <li key={card.to}>
                  <Link to={card.to} className={styles.card}>
                    <span className={styles.cardKicker}>
                      <span aria-hidden="true">{'// '}</span>
                      {card.kicker}
                    </span>
                    <span className={styles.cardTitle}>
                      {card.title}
                      <Icon name="arrow" className={styles.cardArrow} />
                    </span>
                    <span className={styles.cardBody}>{card.body}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </Layout>
  );
}
