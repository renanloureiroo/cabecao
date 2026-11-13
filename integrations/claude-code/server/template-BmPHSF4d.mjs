import{$ as e,En as t,Kt as n,Q as r,an as i,at as a,cn as o,ct as s,dn as c,et as l,gn as u,it as d,kn as f,ln as p,nn as m,nt as h,on as g,rn as _,rt as v,st as y,tt as b,un as x,vn as S,xn as C,xt as w,yn as ee}from"./brain-DW78WG2-.mjs";import{t as T}from"./settings-DZGUTKnC.mjs";import{dirname as E,join as D}from"node:path";import{mkdir as O,readFile as k,rm as A}from"node:fs/promises";import{createHash as j}from"node:crypto";const M=[],N=e=>`# ${e}. Gerado pelo "cabecao obsidian setup"; se você editar este painel, o Cabeção não o substitui mais.\n`,P=`if(valid_until != null && valid_until < today(), "vencida", if(valid_from != null && valid_from > today(), "ainda não vigente", if(superseded_by == null || superseded_by.isEmpty(), "vigente", "substituída")))`,te=`${N(`Memórias ativas por tipo e escopo`)}filters:
  and:
    - file.inFolder("memory")
    - file.ext == "md"
    - not:
        - file.inFolder("memory/_archive")
        - file.name.contains(".conflict-")
        - 'type == "episode"'
        - 'type == "handoff"'
    - or:
        - 'valid_until == null'
        - 'valid_until >= today()'
properties:
  note.type:
    displayName: Tipo
  note.scope:
    displayName: Escopo
  note.trust:
    displayName: Confiança
  note.updated:
    displayName: Atualizada
views:
  - type: table
    name: Por tipo
    order:
      - file.name
      - note.type
      - note.scope
      - note.trust
      - note.updated
    groupBy:
      property: note.type
      direction: ASC
    sort:
      - property: note.updated
        direction: DESC
  - type: table
    name: Por escopo
    order:
      - file.name
      - note.scope
      - note.type
      - note.updated
    groupBy:
      property: note.scope
      direction: ASC
    sort:
      - property: note.updated
        direction: DESC
`,ne=`${N(`Memórias para revisar`)}filters:
  and:
    - file.inFolder("memory")
    - file.ext == "md"
    - 'valid_until == null'
    - not:
        - file.inFolder("memory/_archive")
        - file.name.contains(".conflict-")
        - 'type == "episode"'
        - 'type == "handoff"'
formulas:
  motivo: 'if(edited_by != null, "editada por agente", if(trust == "low", "confiança baixa", if(confirmed == null, "nunca confirmada", "confirmação antiga")))'
  dias_sem_confirmar: 'if(confirmed == null, "", (today() - confirmed).days)'
properties:
  formula.motivo:
    displayName: Motivo
  formula.dias_sem_confirmar:
    displayName: Dias sem confirmar
  note.edited_by:
    displayName: Editada por
views:
  - type: table
    name: Precisam de revisão
    filters:
      or:
        - 'trust == "low"'
        - 'confirmed == null'
        - 'confirmed < today() - "180d"'
        - 'edited_by != null'
    order:
      - file.name
      - note.type
      - note.scope
      - note.confirmed
      - formula.dias_sem_confirmar
      - formula.motivo
    groupBy:
      property: formula.motivo
      direction: ASC
  - type: table
    name: Editadas por agente
    filters:
      and:
        - 'edited_by != null'
    order:
      - file.name
      - note.edited_by
      - note.trust
      - note.origin
      - note.updated
    sort:
      - property: note.updated
        direction: DESC
`,re=`${N(`Decisões vigentes e vencidas`)}filters:
  and:
    - file.ext == "md"
    - or:
        - file.inFolder("wiki/decisions")
        - 'type == "decision"'
    - not:
        - file.inFolder("memory/_archive")
        - file.name.contains(".conflict-")
formulas:
  situacao: '${P}'
properties:
  formula.situacao:
    displayName: Situação
  note.supersedes:
    displayName: Substitui
  note.superseded_by:
    displayName: Substituída por
views:
  - type: table
    name: Vigentes
    filters:
      and:
        - 'formula.situacao == "vigente"'
    order:
      - file.name
      - note.scope
      - note.valid_from
      - note.supersedes
    sort:
      - property: note.valid_from
        direction: DESC
  - type: table
    name: Todas por situação
    order:
      - file.name
      - formula.situacao
      - note.valid_from
      - note.valid_until
      - note.supersedes
      - note.superseded_by
    groupBy:
      property: formula.situacao
      direction: ASC
`,ie=`${N(`Fatos por validade`)}filters:
  and:
    - file.ext == "md"
    - or:
        - file.inFolder("memory/facts")
        - 'type == "fact"'
    - not:
        - file.inFolder("memory/_archive")
        - file.name.contains(".conflict-")
formulas:
  situacao: '${P}'
properties:
  note.subject:
    displayName: Sujeito
  note.predicate:
    displayName: Predicado
  note.object:
    displayName: Objeto
  formula.situacao:
    displayName: Situação
views:
  - type: table
    name: Vigentes
    filters:
      and:
        - 'formula.situacao == "vigente"'
    order:
      - note.subject
      - note.predicate
      - note.object
      - note.valid_from
    groupBy:
      property: note.subject
      direction: ASC
  - type: table
    name: Vencidos e substituídos
    filters:
      or:
        - 'formula.situacao == "vencida"'
        - 'formula.situacao == "substituída"'
    order:
      - note.subject
      - note.predicate
      - note.object
      - note.valid_from
      - note.valid_until
      - note.superseded_by
  - type: table
    name: Todos por situação
    order:
      - note.subject
      - note.predicate
      - note.object
      - note.valid_from
      - note.valid_until
    groupBy:
      property: formula.situacao
      direction: ASC
`,ae=`${N(`Saúde do cérebro`)}filters:
  and:
    - file.ext == "md"
    - not:
        - file.inFolder("memory/_archive")
properties:
  note.edited_by:
    displayName: Editada por
views:
  - type: table
    name: Conflitos de sync pendentes
    filters:
      and:
        - file.name.contains(".conflict-")
    order:
      - file.name
      - file.folder
      - file.mtime
  - type: table
    name: Notas da wiki sem fonte
    filters:
      and:
        - file.inFolder("wiki")
        - not:
            - file.inFolder("wiki/sources")
            - file.name.contains(".conflict-")
        - or:
            - 'sources == null'
            - 'sources.isEmpty()'
    order:
      - file.name
      - note.type
      - note.trust
      - note.origin
  - type: table
    name: Editadas por agente
    filters:
      and:
        - 'edited_by != null'
    order:
      - file.name
      - note.edited_by
      - note.trust
      - note.updated
  - type: table
    name: Órfãs
    filters:
      and:
        - 'file.backlinks.length == 0'
        - 'file.links.length == 0'
        - not:
            - file.inFolder("raw")
            - file.name.contains(".conflict-")
    order:
      - file.name
      - note.type
      - file.mtime
`,F=[{path:`${T}/memorias.base`,title:`Memórias`,description:`memórias ativas por tipo e escopo`,content:te},{path:`${T}/revisar.base`,title:`Revisar`,description:`confiança baixa, sem confirmação há 180 dias e notas editadas por agente`,content:ne},{path:`${T}/decisoes.base`,title:`Decisões`,description:`decisões vigentes, vencidas e substituídas`,content:re},{path:`${T}/fatos.base`,title:`Fatos`,description:`fatos vigentes, vencidos e substituídos`,content:ie},{path:`${T}/saude.base`,title:`Saúde`,description:`conflitos de sync pendentes, notas sem fonte, editadas por agente e órfãs`,content:ae}];function I(){return[...F].sort((e,t)=>e.path<t.path?-1:+(e.path>t.path))}function L(e){return j(`sha256`).update(e.replace(/\r\n/g,`
`),`utf8`).digest(`hex`)}const R={};var z=class extends Error{code;hint;constructor(e,t,n,r){super(t,r),this.name=`MigrationError`,this.code=e,this.hint=n}};async function B(e){let t;try{t=await k(D(e,n),`utf8`)}catch{throw new z(`not_a_brain`,`não achei ${n} em ${e}: a pasta não é um cérebro`)}return V(t)}function V(e){let t;try{t=JSON.parse(e.replace(/^﻿/,``))}catch{throw new z(`invalid_config`,`${n} não é JSON válido`,`Corrija o arquivo e rode de novo.`)}let r=t?.schemaVersion;if(typeof r!=`number`||!Number.isInteger(r)||r<1)throw new z(`invalid_config`,`${n}: "schemaVersion" deveria ser um inteiro a partir de 1`);return r}function H(e,t=M,n=1){let r=[],i=e;for(;i<n;){let e=t.find(e=>e.from===i);if(e===void 0||e.to!==i+1)throw new z(`broken_chain`,`não há migração do esquema ${i} para o ${i+1}`);r.push(e),i=e.to}return r}function U(e,t){let n=JSON.parse(e.replace(/^﻿/,``));return n.schemaVersion=t,`${JSON.stringify(n,null,2)}\n`}function W(e,t){let n=e?.path,r=typeof n==`string`?n.split(`/`)[0]??``:``;if(typeof n!=`string`||!_(n)||n.includes(`\\`)||r===`.git`||r===`.cabecao`||e.content!==null&&typeof e.content!=`string`)throw new z(`unsafe_change`,`a migração ${t.from}→${t.to} quis mexer num caminho que não pode: ${JSON.stringify(n)}`)}function G(e,t){let r=new Map(e),i=[];for(let n of t.migrate(e)){W(n,t);let e=r.get(n.path);(n.content===null?e===void 0:e===n.content)||(n.content===null?r.delete(n.path):r.set(n.path,n.content),i.push({path:n.path,content:n.content}))}let a=r.get(n);return a!==void 0&&r.set(n,U(a,t.to)),{tree:r,changes:i}}async function K(e){let n=await t([`ls-files`,`-z`],{cwd:e}),r=/* @__PURE__ */ new Map;for(let t of n.stdout.split(`\0`).filter(Boolean)){let n;try{n=await k(D(e,...t.split(`/`)))}catch{continue}n.length>8388608||n.includes(0)||r.set(t,n.toString(`utf8`))}return r}function q(e,t=1){if(e>t)throw new z(`schema_too_new`,`este cérebro está no esquema ${e}, e este Cabeção só entende até o ${t}`,`Atualize o Cabeção nesta máquina ("npm i -g cabecao@latest" ou "npx cabecao@latest") e rode de novo.`)}async function J(e,n){let r=await t([`rev-list`,`--count`,n],{cwd:e,allowFailure:!0});return r.exitCode===0?Number(r.stdout.trim()):null}async function oe(e){if((await t([`rev-parse`,`--is-inside-work-tree`],{cwd:e,allowFailure:!0})).exitCode!==0)throw new z(`not_a_repo`,`${e} não é um repositório git`);let n=(await t([`status`,`--porcelain=v1`,`-z`,`--untracked-files=all`],{cwd:e})).stdout.split(`\0`).filter(e=>e.length>3);if(n.length>0){let e=n.slice(0,5).map(e=>e.slice(3)).join(`, `);throw new z(`dirty`,`o cérebro tem ${n.length} ${n.length===1?`mudança`:`mudanças`} fora de commit (${e}${n.length>5?`, ...`:``})`,`Rode "cabecao sync" (que põe as mudanças num commit e sincroniza) e depois "cabecao upgrade" de novo.`)}let r=await t([`rev-parse`,`--abbrev-ref`,`--symbolic-full-name`,`@{upstream}`],{cwd:e,allowFailure:!0});if(r.exitCode!==0)return[`sem remoto configurado: a atualização fica só nesta máquina`];let i=await J(e,`@{upstream}..HEAD`),a=await J(e,`HEAD..@{upstream}`);if((i??0)>0||(a??0)>0)throw new z(`unsynced`,`o cérebro não está sincronizado (${i??`?`} commit(s) a enviar, ${a??`?`} a receber)`,`Rode "cabecao sync" e depois "cabecao upgrade" de novo: a migração tem de partir da versão mais nova de todas as máquinas.`);return[`o remoto não foi consultado agora; o último "cabecao sync" é a referência (${r.stdout.trim()})`]}async function Y(e){if(e!==void 0)return p(e)?e:c(e);try{return(await x())?.machine??o()}catch{return o()}}function X(e){try{let t=JSON.parse(e.replace(/^﻿/,``)).commit;return{...typeof t?.message==`string`&&t.message.trim()!==``?{subjectTemplate:t.message}:{},...typeof t?.dateFormat==`string`&&t.dateFormat.trim()!==``?{dateFormat:t.dateFormat}:{}}}catch{return{}}}const Z=(e,t,r,i)=>({from:e.from,to:e.to,description:e.description,changes:t.filter(e=>e.path!==n).map(e=>({path:e.path,change:e.content===null?`delete`:`write`})),op:r,commit:i});async function se(e,t={}){let r=t.supported??1,a=await B(e);q(a,r);let o=H(a,t.migrations??M,r);if(o.length===0)return{status:`up_to_date`,from:a,to:a,supported:r,steps:[],restorePoint:null,session:null,notes:[]};if(t.dryRun===!0){let t=await K(e),n=[];for(let e of o){let r=G(t,e);t=r.tree,n.push(Z(e,r.changes,null,null))}return{status:`planned`,from:a,to:r,supported:r,steps:n,restorePoint:null,session:null,notes:[]}}let s=w(e),c=[];try{for(let e of[s.syncLock,s.worktreeLock])try{c.push(await g(e,{timeoutMs:5e3}))}catch(e){throw e instanceof i?new z(`busy`,`um sync ou uma escrita está em andamento neste cérebro`,`Espere terminar e rode "cabecao upgrade" de novo.`,{cause:e}):e}let l=await oe(e),d=t.now??(()=>/* @__PURE__ */ new Date),p=m(),h=await Y(t.machine),_=t.client??`cli`,v=await ee(e,`${C(d())}-upgrade`),y=await K(e),b=[];for(let t of o){let r;try{r=G(y,t)}catch(e){throw e instanceof z?e:new z(`migration_failed`,`a migração ${t.from}→${t.to} falhou: ${e instanceof Error?e.message:String(e)}${b.length>0?`; as anteriores ficaram commitadas`:``}`,`Nada desta migração foi gravado. Para voltar ao estado de antes da atualização: "git reset --hard ${v.tag}" no cérebro.`,{cause:e})}for(let t of r.changes){let n=D(e,...t.path.split(`/`));t.content===null?await A(n,{force:!0}):await u(n,t.content)}let i=r.tree.get(n);i!==void 0&&await u(D(e,n),i);let a=m(),o=[.../* @__PURE__ */ new Set([...r.changes.map(e=>e.path),n])],s=f({...X(i??``),date:d(),action:`migrate`,numFiles:o.length,body:[`migrate: ${t.description} (esquema ${t.from} → ${t.to})`,...r.changes.filter(e=>e.path!==n).slice(0,50).map(e=>`${e.content===null?`delete`:`edit`}: ${e.path}`)],trailers:{op:a,session:p,machine:h,client:_}}),c=await S(e,o,s);b.push(Z(t,r.changes,a,c)),y=r.tree}return{status:`upgraded`,from:a,to:r,supported:r,steps:b,restorePoint:v,session:p,notes:l}}finally{for(let e of c.reverse())await e.release()}}async function ce(e,t=1){try{let n=await B(e);return{version:n,supported:t,pending:Math.max(0,t-n),tooNew:n>t}}catch{return null}}const le={[l]:[`b4b7f99a761112c55e79247ef76fa6e55639346e41250ed45c90dbdf26733e27`],[h]:[]},Q=e=>e.replace(/\r\n/g,`
`);async function $(e){try{return await k(e,`utf8`)}catch{return null}}function ue(e,t,n){if(t===null)return{path:e,state:`missing`,current:t,next:null,added:[]};if(Q(t)===n)return{path:e,state:`current`,current:t,next:null,added:[]};let r=le[e]??[],i=t.includes(`\r
`)?n.replace(/\n/g,`\r
`):n;return{path:e,state:r.includes(L(t))?`outdated`:`edited`,current:t,next:i,added:[]}}async function de(t){let n=[];for(let[e,r]of[[l,b],[h,v]])n.push(ue(e,await $(D(t,e)),r));let i=await $(D(t,`.gitignore`))??``,o=e(i,y);n.push({path:a,state:o.added.length===0?`current`:`lines_missing`,current:i,next:o.added.length===0?null:o.content,added:o.added});let c=await $(D(t,`.gitattributes`))??``,u=r(c,s);return n.push({path:d,state:u.added.length===0?`current`:`lines_missing`,current:c,next:u.added.length===0?null:u.content,added:u.added}),n}function fe(e){return e.filter(e=>e.state===`outdated`||e.state===`lines_missing`)}async function pe(e,t){let n=`.cabecao/template/${t.path}`,r=D(e,...n.split(`/`));return await O(E(r),{recursive:!0}),await u(r,t.next??``),n}function me(e,t,n=[`antes`,`depois`]){let r=Q(e).split(`
`),i=Q(t).split(`
`);r.at(-1)===``&&r.pop(),i.at(-1)===``&&i.pop();let a=r.length,o=i.length,s=Array.from({length:a+1},()=>Array(o+1).fill(0));for(let e=a-1;e>=0;e--)for(let t=o-1;t>=0;t--){let n=s[e];n[t]=r[e]===i[t]?s[e+1][t+1]+1:Math.max(s[e+1][t],n[t+1])}let c=[],l=0,u=0;for(;l<a||u<o;)l<a&&u<o&&r[l]===i[u]?(c.push(` ${r[l]}`),l++,u++):l<a&&(u>=o||s[l+1][u]>=s[l][u+1])?(c.push(`-${r[l]}`),l++):(c.push(`+${i[u]}`),u++);let d=c.map(()=>!1);c.forEach((e,t)=>{if(!e.startsWith(` `))for(let e=Math.max(0,t-2);e<=Math.min(c.length-1,t+2);e++)d[e]=!0});let f=[`--- ${n[0]}`,`+++ ${n[1]}`],p=!0;return c.forEach((e,t)=>{d[t]?(p&&f.push(`@@`),p=!1,f.push(e)):p=!0}),f.join(`
`)}async function he(e,n,r={}){let i=new Set(r.replace??[]),a=n.filter(e=>e.next!==null&&(e.state===`outdated`||e.state===`lines_missing`||e.state===`edited`&&i.has(e.path))),o=[];for(let t of n)t.state===`edited`&&!i.has(t.path)&&o.push({path:t.path,aside:await pe(e,t)});if(a.length===0)return{written:[],aside:o,op:null,commit:null};let s=await g(w(e).worktreeLock,{timeoutMs:1e4});try{if((await t([`status`,`--porcelain=v1`,`-z`,`--untracked-files=all`,`--`,...a.map(e=>e.path)],{cwd:e})).stdout.split(`\0`).some(e=>e.length>3))throw new z(`dirty`,`há mudanças fora de commit em ${a.map(e=>e.path).join(`, `)}`,`Rode "cabecao sync" (ou faça o commit dessas mudanças) e depois "cabecao upgrade --template" de novo.`);for(let t of a)await u(D(e,t.path),t.next??``);let n=r.now??(()=>/* @__PURE__ */ new Date),i=m(),s=await $(D(e,`.cabecao.json`))??``,c=a.map(e=>({path:e.path,how:e.state===`lines_missing`?`lines_added`:`replaced`})),l=f({...X(s),date:n(),action:`edit`,numFiles:c.length,body:[`edit: modelo do cérebro atualizado (upgrade --template)`,...c.map(e=>e.how===`replaced`?`edit: ${e.path} trocado pelo modelo atual`:`edit: ${e.path} com as linhas que faltavam do modelo`)],trailers:{op:i,machine:await Y(r.machine),client:r.client??`cli`}});return{written:c,aside:o,op:i,commit:await S(e,c.map(e=>e.path),l)}}finally{await s.release()}}export{z as a,R as c,fe as i,L as l,de as n,ce as o,me as r,se as s,he as t,I as u};