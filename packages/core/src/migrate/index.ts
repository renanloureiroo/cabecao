/** `cabecao upgrade`: migrações do esquema (`schemaVersion`) e a atualização opcional do modelo do cérebro. */
export type { Migration, MigrationChange, MigrationTree } from './migrations.ts';
export { MIGRATIONS } from './migrations.ts';
export type { ApplyTemplateOptions, ApplyTemplateResult, TemplateItem, TemplateState } from './template.ts';
export {
  applyTemplate,
  checkTemplate,
  lineDiff,
  PREVIOUS_TEMPLATE_HASHES,
  TEMPLATE_SIDE_DIR,
  templateUpdatable,
  writeTemplateAside,
} from './template.ts';
export type { MigrationErrorCode, UpgradeOptions, UpgradeResult, UpgradeStep } from './upgrade.ts';
export {
  applyMigration,
  assertNotTooNew,
  MigrationError,
  pendingMigrations,
  readMigrationTree,
  readSchemaVersion,
  schemaState,
  upgradeBrain,
  withSchemaVersion,
} from './upgrade.ts';
