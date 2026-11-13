import{$ as e,Dn as t,Fn as n,Mn as r,Sn as i,St as a,Tn as o,Zt as s,_n as c,at as l,cn as u,ct as d,dn as f,et as p,gn as m,hn as h,it as g,lt as _,mn as v,nt as y,ot as b,rt as x,sn as S,tt as C,un as w,wn as T}from"./brain-B0y1xZ_I.mjs";import{t as E}from"./settings-D3LAn7OS.mjs";import{dirname as D,join as O}from"node:path";import{mkdir as k,readFile as A,rm as j}from"node:fs/promises";import{createHash as ee}from"node:crypto";const M=[],N=e=>`# ${e}. Gerado pelo "cabecao obsidian setup"; se você editar este painel, o Cabeção não o substitui mais.\n`,P=`if(valid_until != null && valid_until < today(), "vencida", if(valid_from != null && valid_from > today(), "ainda não vigente", if(superseded_by == null || superseded_by.isEmpty(), "vigente", "substituída")))`,F=`${N(`Memórias ativas por tipo e escopo`)}filters:
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
`,I=`${N(`Memórias para revisar`)}filters:
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
`,te=`${N(`Decisões vigentes e vencidas`)}filters:
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
`,ne=`${N(`Fatos por validade`)}filters:
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
`,re=`${N(`Saúde do cérebro`)}filters:
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
`,ie=[{path:`${E}/memorias.base`,title:`Memórias`,description:`memórias ativas por tipo e escopo`,content:F},{path:`${E}/revisar.base`,title:`Revisar`,description:`confiança baixa, sem confirmação há 180 dias e notas editadas por agente`,content:I},{path:`${E}/decisoes.base`,title:`Decisões`,description:`decisões vigentes, vencidas e substituídas`,content:te},{path:`${E}/fatos.base`,title:`Fatos`,description:`fatos vigentes, vencidos e substituídos`,content:ne},{path:`${E}/saude.base`,title:`Saúde`,description:`conflitos de sync pendentes, notas sem fonte, editadas por agente e órfãs`,content:re}];function ae(){return[...ie].sort((e,t)=>e.path<t.path?-1:+(e.path>t.path))}function L(e){return ee(`sha256`).update(e.replace(/\r\n/g,`
`),`utf8`).digest(`hex`)}const R={};var z=class extends Error{code;hint;constructor(e,t,n,r){super(t,r),this.name=`MigrationError`,this.code=e,this.hint=n}};async function B(e){let t;try{t=await A(O(e,s),`utf8`)}catch{throw new z(`not_a_brain`,`não achei ${s} em ${e}: a pasta não é um cérebro`)}return V(t)}function V(e){let t;try{t=JSON.parse(e.replace(/^﻿/,``))}catch{throw new z(`invalid_config`,`${s} não é JSON válido`,`Corrija o arquivo e rode de novo.`)}let n=t?.schemaVersion;if(typeof n!=`number`||!Number.isInteger(n)||n<1)throw new z(`invalid_config`,`${s}: "schemaVersion" deveria ser um inteiro a partir de 1`);return n}function H(e,t=M,n=1){let r=[],i=e;for(;i<n;){let e=t.find(e=>e.from===i);if(e===void 0||e.to!==i+1)throw new z(`broken_chain`,`não há migração do esquema ${i} para o ${i+1}`);r.push(e),i=e.to}return r}function U(e,t){let n=JSON.parse(e.replace(/^﻿/,``));return n.schemaVersion=t,`${JSON.stringify(n,null,2)}\n`}function W(e,t){let n=e?.path,r=typeof n==`string`?n.split(`/`)[0]??``:``;if(typeof n!=`string`||!u(n)||n.includes(`\\`)||r===`.git`||r===`.cabecao`||e.content!==null&&typeof e.content!=`string`)throw new z(`unsafe_change`,`a migração ${t.from}→${t.to} quis mexer num caminho que não pode: ${JSON.stringify(n)}`)}function G(e,t){let n=new Map(e),r=[];for(let i of t.migrate(e)){W(i,t);let e=n.get(i.path);(i.content===null?e===void 0:e===i.content)||(i.content===null?n.delete(i.path):n.set(i.path,i.content),r.push({path:i.path,content:i.content}))}let i=n.get(s);return i!==void 0&&n.set(s,U(i,t.to)),{tree:n,changes:r}}async function K(e){let t=await r([`ls-files`,`-z`],{cwd:e}),n=/* @__PURE__ */ new Map;for(let r of t.stdout.split(`\0`).filter(Boolean)){let t;try{t=await A(O(e,...r.split(`/`)))}catch{continue}t.length>8388608||t.includes(0)||n.set(r,t.toString(`utf8`))}return n}function q(e,t=1){if(e>t)throw new z(`schema_too_new`,`este cérebro está no esquema ${e}, e este Cabeção só entende até o ${t}`,`Atualize o Cabeção nesta máquina e rode de novo ("cabecao doctor" mostra o comando para a sua instalação).`)}async function J(e,t){let n=await r([`rev-list`,`--count`,t],{cwd:e,allowFailure:!0});return n.exitCode===0?Number(n.stdout.trim()):null}async function oe(e){if((await r([`rev-parse`,`--is-inside-work-tree`],{cwd:e,allowFailure:!0})).exitCode!==0)throw new z(`not_a_repo`,`${e} não é um repositório git`);let t=(await r([`status`,`--porcelain=v1`,`-z`,`--untracked-files=all`],{cwd:e})).stdout.split(`\0`).filter(e=>e.length>3);if(t.length>0){let e=t.slice(0,5).map(e=>e.slice(3)).join(`, `);throw new z(`dirty`,`o cérebro tem ${t.length} ${t.length===1?`mudança`:`mudanças`} fora de commit (${e}${t.length>5?`, ...`:``})`,`Rode "cabecao sync" (que põe as mudanças num commit e sincroniza) e depois "cabecao upgrade" de novo.`)}let n=await r([`rev-parse`,`--abbrev-ref`,`--symbolic-full-name`,`@{upstream}`],{cwd:e,allowFailure:!0});if(n.exitCode!==0)return[`sem remoto configurado: a atualização fica só nesta máquina`];let i=await J(e,`@{upstream}..HEAD`),a=await J(e,`HEAD..@{upstream}`);if((i??0)>0||(a??0)>0)throw new z(`unsynced`,`o cérebro não está sincronizado (${i??`?`} commit(s) a enviar, ${a??`?`} a receber)`,`Rode "cabecao sync" e depois "cabecao upgrade" de novo: a migração tem de partir da versão mais nova de todas as máquinas.`);return[`o remoto não foi consultado agora; o último "cabecao sync" é a referência (${n.stdout.trim()})`]}async function Y(e){if(e!==void 0)return h(e)?e:c(e);try{return(await m())?.machine??v()}catch{return v()}}function X(e){try{let t=JSON.parse(e.replace(/^﻿/,``)).commit;return{...typeof t?.message==`string`&&t.message.trim()!==``?{subjectTemplate:t.message}:{},...typeof t?.dateFormat==`string`&&t.dateFormat.trim()!==``?{dateFormat:t.dateFormat}:{}}}catch{return{}}}const Z=(e,t,n,r)=>({from:e.from,to:e.to,description:e.description,changes:t.filter(e=>e.path!==s).map(e=>({path:e.path,change:e.content===null?`delete`:`write`})),op:n,commit:r});async function se(e,r={}){let c=r.supported??1,l=await B(e);q(l,c);let u=H(l,r.migrations??M,c);if(u.length===0)return{status:`up_to_date`,from:l,to:l,supported:c,steps:[],restorePoint:null,session:null,notes:[]};if(r.dryRun===!0){let t=await K(e),n=[];for(let e of u){let r=G(t,e);t=r.tree,n.push(Z(e,r.changes,null,null))}return{status:`planned`,from:l,to:c,supported:c,steps:n,restorePoint:null,session:null,notes:[]}}let d=a(e),p=[];try{for(let e of[d.syncLock,d.worktreeLock])try{p.push(await f(e,{timeoutMs:5e3}))}catch(e){throw e instanceof w?new z(`busy`,`um sync ou uma escrita está em andamento neste cérebro`,`Espere terminar e rode "cabecao upgrade" de novo.`,{cause:e}):e}let a=await oe(e),m=r.now??(()=>/* @__PURE__ */ new Date),h=S(),g=await Y(r.machine),_=r.client??`cli`,v=await o(e,`${t(m())}-upgrade`),y=await K(e),b=[];for(let t of u){let r;try{r=G(y,t)}catch(e){throw e instanceof z?e:new z(`migration_failed`,`a migração ${t.from}→${t.to} falhou: ${e instanceof Error?e.message:String(e)}${b.length>0?`; as anteriores ficaram commitadas`:``}`,`Nada desta migração foi gravado. Para voltar ao estado de antes da atualização: "git reset --hard ${v.tag}" no cérebro.`,{cause:e})}for(let t of r.changes){let n=O(e,...t.path.split(`/`));t.content===null?await j(n,{force:!0}):await i(n,t.content)}let a=r.tree.get(s);a!==void 0&&await i(O(e,s),a);let o=S(),c=[.../* @__PURE__ */ new Set([...r.changes.map(e=>e.path),s])],l=n({...X(a??``),date:m(),action:`migrate`,numFiles:c.length,body:[`migrate: ${t.description} (esquema ${t.from} → ${t.to})`,...r.changes.filter(e=>e.path!==s).slice(0,50).map(e=>`${e.content===null?`delete`:`edit`}: ${e.path}`)],trailers:{op:o,session:h,machine:g,client:_}}),u=await T(e,c,l);b.push(Z(t,r.changes,o,u)),y=r.tree}return{status:`upgraded`,from:l,to:c,supported:c,steps:b,restorePoint:v,session:h,notes:a}}finally{for(let e of p.reverse())await e.release()}}async function ce(e,t=1){try{let n=await B(e);return{version:n,supported:t,pending:Math.max(0,t-n),tooNew:n>t}}catch{return null}}const le={[C]:[`b4b7f99a761112c55e79247ef76fa6e55639346e41250ed45c90dbdf26733e27`],[x]:[]},Q=e=>e.replace(/\r\n/g,`
`);async function $(e){try{return await A(e,`utf8`)}catch{return null}}function ue(e,t,n){if(t===null)return{path:e,state:`missing`,current:t,next:null,added:[]};if(Q(t)===n)return{path:e,state:`current`,current:t,next:null,added:[]};let r=le[e]??[],i=t.includes(`\r
`)?n.replace(/\n/g,`\r
`):n;return{path:e,state:r.includes(L(t))?`outdated`:`edited`,current:t,next:i,added:[]}}async function de(t){let n=[];for(let[e,r]of[[C,y],[x,g]])n.push(ue(e,await $(O(t,e)),r));let r=await $(O(t,`.gitignore`))??``,i=p(r,d);n.push({path:b,state:i.added.length===0?`current`:`lines_missing`,current:r,next:i.added.length===0?null:i.content,added:i.added});let a=await $(O(t,`.gitattributes`))??``,o=e(a,_);return n.push({path:l,state:o.added.length===0?`current`:`lines_missing`,current:a,next:o.added.length===0?null:o.content,added:o.added}),n}function fe(e){return e.filter(e=>e.state===`outdated`||e.state===`lines_missing`)}async function pe(e,t){let n=`.cabecao/template/${t.path}`,r=O(e,...n.split(`/`));return await k(D(r),{recursive:!0}),await i(r,t.next??``),n}function me(e,t,n=[`antes`,`depois`]){let r=Q(e).split(`
`),i=Q(t).split(`
`);r.at(-1)===``&&r.pop(),i.at(-1)===``&&i.pop();let a=r.length,o=i.length,s=Array.from({length:a+1},()=>Array(o+1).fill(0));for(let e=a-1;e>=0;e--)for(let t=o-1;t>=0;t--){let n=s[e];n[t]=r[e]===i[t]?s[e+1][t+1]+1:Math.max(s[e+1][t],n[t+1])}let c=[],l=0,u=0;for(;l<a||u<o;)l<a&&u<o&&r[l]===i[u]?(c.push(` ${r[l]}`),l++,u++):l<a&&(u>=o||s[l+1][u]>=s[l][u+1])?(c.push(`-${r[l]}`),l++):(c.push(`+${i[u]}`),u++);let d=c.map(()=>!1);c.forEach((e,t)=>{if(!e.startsWith(` `))for(let e=Math.max(0,t-2);e<=Math.min(c.length-1,t+2);e++)d[e]=!0});let f=[`--- ${n[0]}`,`+++ ${n[1]}`],p=!0;return c.forEach((e,t)=>{d[t]?(p&&f.push(`@@`),p=!1,f.push(e)):p=!0}),f.join(`
`)}async function he(e,t,o={}){let s=new Set(o.replace??[]),c=t.filter(e=>e.next!==null&&(e.state===`outdated`||e.state===`lines_missing`||e.state===`edited`&&s.has(e.path))),l=[];for(let n of t)n.state===`edited`&&!s.has(n.path)&&l.push({path:n.path,aside:await pe(e,n)});if(c.length===0)return{written:[],aside:l,op:null,commit:null};let u=await f(a(e).worktreeLock,{timeoutMs:1e4});try{if((await r([`status`,`--porcelain=v1`,`-z`,`--untracked-files=all`,`--`,...c.map(e=>e.path)],{cwd:e})).stdout.split(`\0`).some(e=>e.length>3))throw new z(`dirty`,`há mudanças fora de commit em ${c.map(e=>e.path).join(`, `)}`,`Rode "cabecao sync" (ou faça o commit dessas mudanças) e depois "cabecao upgrade --template" de novo.`);for(let t of c)await i(O(e,t.path),t.next??``);let t=o.now??(()=>/* @__PURE__ */ new Date),a=S(),s=await $(O(e,`.cabecao.json`))??``,u=c.map(e=>({path:e.path,how:e.state===`lines_missing`?`lines_added`:`replaced`})),d=n({...X(s),date:t(),action:`edit`,numFiles:u.length,body:[`edit: modelo do cérebro atualizado (upgrade --template)`,...u.map(e=>e.how===`replaced`?`edit: ${e.path} trocado pelo modelo atual`:`edit: ${e.path} com as linhas que faltavam do modelo`)],trailers:{op:a,machine:await Y(o.machine),client:o.client??`cli`}});return{written:u,aside:l,op:a,commit:await T(e,u.map(e=>e.path),d)}}finally{await u.release()}}export{z as a,R as c,fe as i,L as l,de as n,ce as o,me as r,se as s,he as t,ae as u};