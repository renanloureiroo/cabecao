import Link from '@docusaurus/Link';
import Translate, { translate } from '@docusaurus/Translate';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Admonition from '@theme/Admonition';
import CodeBlock from '@theme/CodeBlock';
import Layout from '@theme/Layout';
import ThemedImage from '@theme/ThemedImage';
import type { ReactNode } from 'react';
import styles from './index.module.css';

interface Feature {
  readonly title: string;
  readonly body: ReactNode;
}

function features(): Feature[] {
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

export default function Home(): ReactNode {
  const title = translate({ id: 'home.title', message: 'Um segundo cérebro que os seus agentes também leem' });
  return (
    <Layout
      title={translate({ id: 'home.meta.title', message: 'Segundo cérebro em Markdown e git' })}
      description={translate({
        id: 'home.meta.description',
        message: 'Seu segundo cérebro em Markdown e git, para você e seus agentes de IA, servido por MCP.',
      })}
    >
      <header className={styles.hero}>
        <div className={`container ${styles.heroInner}`}>
          <div>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.tagline}>
              <Translate id="home.tagline">
                {
                  'Suas notas ficam em Markdown, num repositório git que é seu. Os agentes de IA consultam e gravam nelas por MCP, e tudo o que eles fazem vira um commit que você desfaz com um comando.'
                }
              </Translate>
            </p>
            <div className={styles.actions}>
              <Link className="button button--primary button--lg" to="/comecar/instalacao/">
                <Translate id="home.cta.start">Começar</Translate>
              </Link>
              <Link className="button button--link button--lg" href="https://github.com/renanloureiroo/cabecao">
                <Translate id="home.cta.github">Ver no GitHub</Translate>
              </Link>
            </div>
          </div>
          <ThemedImage
            className={styles.mark}
            alt=""
            sources={{ light: useBaseUrl('/img/logo-light.svg'), dark: useBaseUrl('/img/logo-dark.svg') }}
          />
        </div>
      </header>

      <main className="container">
        <section className={styles.section}>
          <Admonition type="caution" title={translate({ id: 'home.beta.title', message: 'Versão beta' })}>
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

        <section className={styles.section}>
          <h2>
            <Translate id="home.audience.title">Para quem é</Translate>
          </h2>
          <p>
            <Translate id="home.audience.body">
              {
                'Para quem trabalha com agentes de IA (Claude Code, Codex, Cursor e outros) e cansou de repetir as mesmas preferências, decisões e armadilhas a cada sessão nova. O que você ensina numa conversa fica guardado e volta na próxima, em qualquer cliente e em qualquer máquina.'
              }
            </Translate>
          </p>
        </section>

        <section className={styles.section}>
          <h2>
            <Translate id="home.features.title">O que o diferencia</Translate>
          </h2>
          <ul className={styles.features}>
            {features().map((feature) => (
              <li key={feature.title} className={styles.feature}>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className={`${styles.section} ${styles.last}`}>
          <h2>
            <Translate id="home.quick.title">Em três comandos</Translate>
          </h2>
          <CodeBlock language="bash">
            {'npm i -g cabecao@beta\ncabecao init git@github.com:voce/cerebro.git\ncabecao doctor'}
          </CodeBlock>
          <p>
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
        </section>
      </main>
    </Layout>
  );
}
