import { readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
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

              // ── CORRECTION PRINCIPALE ──────────────────────────────────────
              // On stocke toujours par interaction.name comme clé primaire.
              // Mais si le handler déclare une méthode match(), on l'enregistre
              // aussi dans client[type + 'Matchers'] pour le dispatcher.
              // Cela évite de casser les handlers existants qui font un match
              // exact, tout en permettant le matching partiel pour create_ticket.
              // ──────────────────────────────────────────────────────────────
              client[type].set(interaction.name, interaction);

              if (typeof interaction.match === 'function') {
                // Liste séparée pour les handlers avec matching custom
                if (!client[`${type}Matchers`]) {
                  client[`${type}Matchers`] = [];
                }
                client[`${type}Matchers`].push(interaction);
                logger.info(
                  `Loaded ${type.slice(0, -1)} (with custom matcher): ${interaction.name}`,
                );
              } else {
                logger.info(`Loaded ${type.slice(0, -1)}: ${interaction.name}`);
              }

              loadedCount += 1;
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

// ─── Helper exporté pour le dispatcher ───────────────────────────────────────
/**
 * Trouve le handler correspondant à un customId dans une Map client[type].
 *
 * Ordre de priorité :
 *  1. handler.match(customId)  → matching custom (ex: create_ticket_2)
 *  2. client[type].get(customId) → matching exact sur le nom
 *  3. Fallback préfixe : cherche un handler dont le name est un préfixe du customId
 *
 * @param {Map} handlerMap       - client.buttons / client.modals / client.selectMenus
 * @param {Array} matchersList   - client.buttonsMatchers / etc. (peut être undefined)
 * @param {string} customId      - le customId sans les args (avant le ":")
 * @returns {Object|null}
 */
export function findInteractionHandler(handlerMap, matchersList, customId) {
  // 1. Matchers custom (handlers avec match())
  if (matchersList?.length) {
    const matched = matchersList.find(h => h.match(customId));
    if (matched) return matched;
  }

  // 2. Exact
  const exact = handlerMap?.get(customId);
  if (exact) return exact;

  // 3. Préfixe (fallback pour les handlers sans match() mais avec suffixe _N)
  if (handlerMap) {
    for (const [name, handler] of handlerMap.entries()) {
      if (customId.startsWith(name + '_')) return handler;
    }
  }

  return null;
}
