// Processo filho do teste de escritores concorrentes. JavaScript puro para rodar em qualquer Node aceito.
//   <arquivo> <letra> <tamanho> <vezes>   grava <vezes> o arquivo inteiro preenchido com <letra>
import { writeFileAtomic } from '../../src/util/index.ts';

const [filePath, letter, size, times] = process.argv.slice(2);
const payload = letter.repeat(Number(size));
for (let i = 0; i < Number(times); i++) {
  await writeFileAtomic(filePath, payload);
}
