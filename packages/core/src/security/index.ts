// API pública do scanner de segredos.

export {
  type FrontmatterSecretFinding,
  type ScanFrontmatterOptions,
  scanFrontmatterSecrets,
} from './frontmatter.ts';
export { redactSecret } from './heuristics.ts';
export { SECRET_RULE_IDS, type SecretRuleId } from './rules.ts';
export {
  ALLOW_SECRET_MARKER,
  allowMarkerApplies,
  type ScanSecretsOptions,
  type SecretFinding,
  scanSecrets,
} from './scan.ts';

import { SECRET_RULES as RULES, type SecretRuleId } from './rules.ts';

/** Catálogo das regras, na ordem de prioridade, para documentação e para o `doctor`. */
export const SECRET_RULES: readonly { id: SecretRuleId; description: string }[] = RULES.map(({ id, description }) => ({
  id,
  description,
}));
