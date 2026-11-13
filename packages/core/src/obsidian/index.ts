/** Integração com o Obsidian: configuração do vault, painéis, modelo do Web Clipper e mapas (`.canvas`). Só funções puras. */
export type {
  CanvasEdge,
  CanvasEdgeInput,
  CanvasEnd,
  CanvasInput,
  CanvasNode,
  CanvasNoteInput,
  CanvasSide,
  CanvasValidationOptions,
  JsonCanvas,
} from './canvas.ts';
export { buildCanvas, CANVAS_LAYOUT, canvasFile, canvasNodeId, canvasOverlaps, validateCanvas } from './canvas.ts';
export type { ClipperProperty, ClipperTemplate } from './clipper.ts';
export {
  CLIPPER_BEHAVIORS,
  CLIPPER_PROPERTY_TYPES,
  CLIPPER_SCHEMA_VERSION,
  CLIPPER_TEMPLATE_PATH,
  validateClipperTemplate,
  webClipperTemplate,
  webClipperTemplateFile,
} from './clipper.ts';
export type { DashboardFile } from './dashboards.ts';
export { contentHash, dashboardFiles, PREVIOUS_DASHBOARD_HASHES } from './dashboards.ts';
export type { ColorGroup } from './palette.ts';
export { COLOR_GROUPS, graphQuery, groupOf, OTHER_GROUP, rgbInt } from './palette.ts';
export type { GraphColorGroup, JsonLike, ObsidianSettings, ObsidianSettingsFile } from './settings.ts';
export { OBSIDIAN_DASHBOARDS_DIR, OBSIDIAN_DIR, OBSIDIAN_SETTINGS_FILES, obsidianSettings } from './settings.ts';
