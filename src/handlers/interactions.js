import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const interactionTypes = ['buttons', 'selectMenus', 'modals'];

export default async (client) => {
  try {
    const interactionsPath = join(__dirname, '../interactions');

    for (const type of interactionTypes) {
      const typePath = join(interactionsPath, type);

      try {
        const interactionFiles = (await readdir(typePath)).filter(file =>
          file.endsWith('.js'),
        );
        let loadedCount = 0;

        for (const file of interactionFiles) {
          try {
            const module = await import(`../interactions/${type}/${file}`);
            const moduleExport = module.default;
            const interactions = Array.isArray(moduleExport)
              ? moduleExport
              : [moduleExport];

            for (const interaction of interactions) {
              if (!interaction?.name || !interaction?.execute) {
                logger.warn(
                  `Interaction ${file} in ${type} is missing required properties (name or execute).`,
                );
                continue;
              }

              // Stockage par name (clé exacte) — comportement original conservé
              client[type].set(interaction.name, interaction);
              loadedCount += 1;
              logger.info(`Loaded ${type.slice(0, -1)}: ${interaction.name}`);
            }
          } catch (error) {
            logger.error(`Error loading interaction ${file} in ${type}:`, error);
          }
        }

        logger.info(`Loaded ${loadedCount} ${type}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.error(`Error loading ${type}:`, error);
        } else {
          logger.debug(`No ${type} directory found, skipping...`);
        }
      }
    }
  } catch (error) {
    logger.error('Error loading interactions:', error);
  }
};

// ─── Helper partagé avec interactionCreate.js ─────────────────────────────────
//
// Résout le handler pour un customId selon 3 stratégies :
//   1. handler.match(customId)     — matching custom déclaré sur le handler
//   2. handlerMap.get(customId)    — matching exact (comportement original)
//   3. préfixe + '_'               — fallback pour suffixes dynamiques (_0, _1…)
//
// Cela permet à create_ticket_0, create_ticket_modal_1, etc. d'être routés
// vers leur handler sans casser aucun handler existant.
//
export function findHandler(handlerMap, customId) {
  if (!handlerMap) return null;

  // 1. match() custom
  for (const handler of handlerMap.values()) {
    if (typeof handler.match === 'function' && handler.match(customId)) {
      return handler;
    }
  }

  // 2. Exact
  const exact = handlerMap.get(customId);
  if (exact) return exact;

  // 3. Préfixe (ex: "create_ticket_2" → handler nommé "create_ticket")
  for (const [name, handler] of handlerMap.entries()) {
    if (customId.startsWith(name + '_')) return handler;
  }

  return null;
}
