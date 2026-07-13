import chalk from 'chalk';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zod from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const BLUEPRINTS_DIR = resolve(ROOT, 'blueprints');

type Category = 'notification' | 'recording' | 'presence' | 'detection' | 'schedule' | 'webhook' | 'mqtt' | 'scene' | 'utility' | 'other';

type InputType = 'camera' | 'plugin' | 'sensor' | 'notification-targets' | 'system-target' | 'text';

interface BlueprintInput {
  key: string;
  type: InputType;
  label?: string;
  interface?: string;
  multiple?: boolean;
  placeholder?: string;
  default?: string;
}

interface RequiredInput {
  type: InputType;
  count?: number;
}

interface CatalogEntry {
  title: string;
  description?: string;
  category: Category;
  author: string;
  featured: boolean;
  tags: string[];
  requiredPlugins: string[];
  requiredInputs: RequiredInput[];
  blueprint: string;
}

// This mirrors server/src/api/schemas/automations.schema.ts:importBlueprintSchema.
// Kept in sync by hand — a blueprint that fails this MUST NOT ship.
const VALID_NODE_TYPES = [
  'trigger-detection',
  'trigger-sensor',
  'trigger-schedule',
  'trigger-webhook',
  'trigger-system',
  'trigger-manual',
  'trigger-geofence',
  'trigger-mqtt',
  'condition-ifelse',
  'condition-switch',
  'condition-sensorstate',
  'condition-time',
  'action-snapshot',
  'action-sensor',
  'action-notification',
  'action-http',
  'action-mqtt',
  'action-delay',
  'action-variable',
  'action-plugin',
  'action-camera-control',
  'action-image-input',
  'action-output',
] as const;

const automationNodeSchema = zod.object({
  id: zod.string().min(1, 'ID is required'),
  type: zod.enum(VALID_NODE_TYPES),
  position: zod.object({ x: zod.number(), y: zod.number() }),
  data: zod.record(zod.string(), zod.unknown()),
});

const automationEdgeSchema = zod.object({
  id: zod.string().min(1, 'ID is required'),
  source: zod.string().min(1, 'Source is required'),
  target: zod.string().min(1, 'Target is required'),
  sourceHandle: zod.string().optional(),
  targetHandle: zod.string().optional(),
});

function validateEdgeRefs(nodes: { id: string }[], edges: { source: string; target: string }[]): boolean {
  const nodeIds = new Set(nodes.map((n) => n.id));
  return edges.every((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
}

const importBlueprintSchema = zod
  .object({
    version: zod.literal(1),
    name: zod.string().trim().min(1, 'Name is required').max(200, 'Name cannot be more than 200 characters'),
    description: zod.string().trim().optional(),
    nodes: zod.array(automationNodeSchema).min(1, 'Blueprint must contain at least one node'),
    edges: zod.array(automationEdgeSchema),
  })
  .refine((data) => validateEdgeRefs(data.nodes, data.edges), {
    message: 'Edges reference non-existent nodes',
  });

// The store repo owns these curated fields; the rest is derived from the blueprint.
const CURATED: Record<string, { category: Category; featured: boolean; tags: string[]; author?: string }> = {
  'front-door-person-alert': { category: 'detection', featured: true, tags: ['detection', 'doorbell', 'person'] },
  'motion-night-snapshot-notify': { category: 'notification', featured: false, tags: ['motion', 'night', 'snapshot'] },
  'person-detected-notifier-plugin': { category: 'notification', featured: false, tags: ['detection', 'person', 'plugin'] },
  'webhook-doorbell': { category: 'webhook', featured: true, tags: ['doorbell', 'webhook', 'virtual-sensor'] },
  'doorbell-ring-notify': { category: 'notification', featured: false, tags: ['doorbell', 'sensor', 'notification'] },
  'mqtt-doorbell': { category: 'mqtt', featured: true, tags: ['doorbell', 'mqtt', 'virtual-sensor'] },
};

const DEFAULT_CURATED = { category: 'other' as Category, featured: false, tags: [] as string[], author: 'camera.ui' };

interface Blueprint {
  version: 1;
  name: string;
  description?: string;
  inputs?: BlueprintInput[];
  nodes: Array<{ type: string; data: Record<string, unknown> }>;
  edges: unknown[];
}

function discoverBlueprints(): string[] {
  return readdirSync(BLUEPRINTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.blueprint.json'))
    .map((entry) => entry.name)
    .sort();
}

function idFromFile(file: string): string {
  return basename(file, '.blueprint.json');
}

function deriveRequiredPlugins(bp: Blueprint): string[] {
  const interfaces = new Set<string>();
  for (const input of bp.inputs ?? []) {
    if (input.type === 'plugin' && input.interface) interfaces.add(input.interface);
  }
  for (const node of bp.nodes) {
    if (node.type === 'action-plugin' && typeof node.data.pluginInterface === 'string' && node.data.pluginInterface) {
      interfaces.add(node.data.pluginInterface);
    }
  }
  return [...interfaces].sort();
}

function deriveRequiredInputs(bp: Blueprint): RequiredInput[] {
  const counts = new Map<InputType, number>();
  for (const input of bp.inputs ?? []) {
    // Plugin inputs are surfaced through requiredPlugins, not here. Text inputs
    // are plain values the wizard prefills, not a resource the card must
    // advertise — and clients without the text input type would choke on them.
    if (input.type === 'plugin' || input.type === 'text') continue;
    counts.set(input.type, (counts.get(input.type) ?? 0) + 1);
  }

  const order: InputType[] = ['camera', 'sensor', 'system-target', 'notification-targets'];
  const result: RequiredInput[] = [];
  for (const type of order) {
    const count = counts.get(type);
    if (!count) continue;
    // Notification targets are conceptually a single "who to notify" need.
    result.push(type === 'notification-targets' ? { type } : { type, count });
  }
  return result;
}

function buildEntry(file: string, bp: Blueprint): CatalogEntry {
  const id = idFromFile(file);
  const curated = CURATED[id] ?? DEFAULT_CURATED;

  return {
    title: bp.name,
    ...(bp.description ? { description: bp.description } : {}),
    category: curated.category,
    author: ('author' in curated && curated.author) || DEFAULT_CURATED.author,
    featured: curated.featured,
    tags: curated.tags,
    requiredPlugins: deriveRequiredPlugins(bp),
    requiredInputs: deriveRequiredInputs(bp),
    blueprint: `blueprints/${file}`,
  };
}

function main(): void {
  const files = discoverBlueprints();
  if (!files.length) {
    console.error('\r\n', chalk.bgRed.bold(' ERROR '), chalk.red('No *.blueprint.json files found in blueprints/.'));
    process.exit(1);
  }

  const catalog: Record<string, CatalogEntry> = {};
  for (const file of files) {
    const raw = JSON.parse(readFileSync(resolve(BLUEPRINTS_DIR, file), 'utf-8'));

    const parsed = importBlueprintSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('\r\n', chalk.bgRed.bold(' INVALID '), chalk.red(`${file} does not satisfy importBlueprintSchema:`));
      for (const issue of parsed.error.issues) {
        console.error('   ', chalk.red(`• ${issue.path.join('.') || '(root)'}: ${issue.message}`));
      }
      process.exit(1);
    }

    catalog[idFromFile(file)] = buildEntry(file, raw as Blueprint);
    console.log(`  ${chalk.green('✓')} ${chalk.bold(file)} ${chalk.gray('valid')}`);
  }

  const sorted: Record<string, CatalogEntry> = {};
  for (const id of Object.keys(catalog).sort()) {
    sorted[id] = catalog[id];
  }

  const outPath = resolve(ROOT, 'catalog.json');
  writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n');

  console.log(chalk.cyan(`\r\nWrote ${chalk.bold(String(Object.keys(sorted).length))} blueprints to catalog.json\r\n`));
  for (const id of Object.keys(sorted)) {
    const { category, featured } = sorted[id];
    console.log(`  ${featured ? chalk.yellow('★') : ' '} ${chalk.bold(id)} ${chalk.gray('->')} ${category}`);
  }
  console.log('\r\n', chalk.bgGreen(' SUCCESS '), chalk.green(`catalog.json written to ${outPath}`));
}

main();
