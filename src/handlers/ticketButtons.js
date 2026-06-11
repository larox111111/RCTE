import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
} from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../utils/embeds.js';
import {
  createTicket,
  closeTicket,
  claimTicket,
  updateTicketPriority,
} from '../services/ticket.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logTicketEvent } from '../utils/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { getTicketPermissionContext } from '../utils/ticketPermissions.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Vérifie que l'interaction vient bien d'un serveur.
 * Répond automatiquement avec une erreur si ce n'est pas le cas.
 */
async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) return true;
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          'Serveur uniquement',
          'Cette action ne peut être utilisée que dans un serveur.',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }
  return false;
}

/**
 * Vérifie les permissions de ticket avec un timeout.
 * Retourne { success, context } ou { success: false, error, details }.
 */
async function checkTicketPermissionWithTimeout(
  interaction,
  client,
  actionLabel,
  options = {},
  timeoutMs = 2500,
) {
  const { allowTicketCreator = false } = options;
  try {
    const context = await Promise.race([
      getTicketPermissionContext({ client, interaction }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs),
      ),
    ]);

    if (!context.ticketData) {
      return {
        success: false,
        error: 'Pas un salon ticket',
        details: 'Cette action ne peut être utilisée que dans un salon ticket valide.',
      };
    }

    const allowed = allowTicketCreator
      ? context.canCloseTicket
      : context.canManageTicket;

    if (!allowed) {
      const permissionMessage = allowTicketCreator
        ? 'Tu dois avoir la permission **Gérer les salons**, le **rôle Staff** configuré, ou être le **créateur du ticket**.'
        : 'Tu dois avoir la permission **Gérer les salons** ou le **rôle Staff** configuré.';
      return {
        success: false,
        error: 'Permission refusée',
        details: `${permissionMessage}\n\nTu ne peux pas ${actionLabel}.`,
      };
    }

    return { success: true, context };
  } catch (error) {
    if (error.message === 'Timeout') {
      return {
        success: false,
        error: 'Délai dépassé',
        details: 'La vérification des permissions a pris trop de temps. Réessaie.',
      };
    }
    return {
      success: false,
      error: 'Erreur',
      details: `Impossible de vérifier les permissions : ${error.message}`,
    };
  }
}

/**
 * Répond avec l'erreur de permission si la vérification échoue.
 */
async function replyPermissionError(interaction, permissionCheck) {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ─── CREATE TICKET ────────────────────────────────────────────────────────────

/**
 * Handler pour les boutons create_ticket et create_ticket_N.
 *
 * BUG CORRIGÉ : Le dispatcher doit router tous les customIds qui commencent
 * par "create_ticket" vers ce handler. La propriété `match` est utilisée
 * pour ça (voir interactionCreate.js).
 */
const createTicketHandler = {
  name: 'create_ticket',

  // Utilisé par le dispatcher pour matcher create_ticket ET create_ticket_0, create_ticket_1, etc.
  match(customId) {
    return customId === 'create_ticket' || /^create_ticket_\d+$/.test(customId);
  },

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Rate limit : max 3 créations par minute
      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60_000);
      if (!allowed) {
        return await interaction.reply({
          embeds: [
            errorEmbed(
              'Limite atteinte',
              "Tu crées des tickets trop rapidement. Attends une minute et réessaie.",
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;

      const { getUserTicketCount } = await import('../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(
        interaction.guildId,
        interaction.user.id,
      );

      if (currentTicketCount >= maxTicketsPerUser) {
        return await interaction.reply({
          embeds: [
            errorEmbed(
              '🎫 Limite de tickets atteinte',
              `Tu as atteint le nombre maximum de tickets ouverts (${maxTicketsPerUser}).\n\n` +
                `Ferme tes tickets existants avant d'en créer un nouveau.\n\n` +
                `**Tickets actuels :** ${currentTicketCount}/${maxTicketsPerUser}`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      // Déterminer l'index du bouton cliqué
      // customId = "create_ticket" → index 0
      // customId = "create_ticket_2" → index 2
      const customId = interaction.customId;
      const buttonIndex =
        customId === 'create_ticket' ? 0 : parseInt(customId.split('_').pop(), 10);

      const ticketButtons = config.ticketButtons || [
        { label: config.ticketButtonLabel || 'Créer un ticket', emoji: '📩' },
      ];
      const ticketType = ticketButtons[buttonIndex]?.label || 'Ticket';

      const modal = new ModalBuilder()
        .setCustomId(`create_ticket_modal_${buttonIndex}`)
        .setTitle(ticketType)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('reason')
              .setLabel('Pourquoi tu crées ce ticket ?')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Décris ton problème ou ta demande...')
              .setRequired(true)
              .setMaxLength(1000),
          ),
        );

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Erreur création modal ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [
            errorEmbed('Erreur', "Impossible d'ouvrir le formulaire de création de ticket."),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

// ─── CREATE TICKET MODAL ──────────────────────────────────────────────────────

/**
 * Handler pour les modals create_ticket_modal et create_ticket_modal_N.
 *
 * BUG CORRIGÉ : Même logique de matching partiel que pour le bouton.
 */
const createTicketModalHandler = {
  name: 'create_ticket_modal',

  match(customId) {
    return (
      customId === 'create_ticket_modal' || /^create_ticket_modal_\d+$/.test(customId)
    );
  },

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;

      // Déterminer l'index depuis le customId du modal
      const modalCustomId = interaction.customId;
      const buttonIndex =
        modalCustomId === 'create_ticket_modal'
          ? 0
          : parseInt(modalCustomId.split('_').pop(), 10);

      const ticketButtons = config.ticketButtons || [
        { label: config.ticketButtonLabel || 'Ticket', emoji: '📩' },
      ];
      const ticketType = ticketButtons[buttonIndex]?.label || 'Ticket';

      const result = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
        'none',
        ticketType,
      );

      if (result.success) {
        await interaction.editReply({
          embeds: [
            successEmbed('✅ Ticket créé !', `Ton ticket a été créé dans ${result.channel} !`),
          ],
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', result.error || 'Impossible de créer le ticket.')],
        });
      }
    } catch (error) {
      logger.error('Erreur création ticket:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          embeds: [
            errorEmbed('Erreur', 'Une erreur est survenue lors de la création du ticket.'),
          ],
        });
      }
    }
  },
};

// ─── CLOSE TICKET (bouton) ────────────────────────────────────────────────────

const closeTicketHandler = {
  name: 'ticket_close',

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'fermer ce ticket',
        { allowTicketCreator: true },
        2000,
      );
      if (!permissionCheck.success) {
        return await replyPermissionError(interaction, permissionCheck);
      }

      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle('Fermer le ticket')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('reason')
              .setLabel('Raison de la fermeture (optionnel)')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Ajoute une raison optionnelle...')
              .setRequired(false)
              .setMaxLength(1000),
          ),
        );

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Erreur fermeture ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [
            errorEmbed('Erreur', "Impossible d'ouvrir le formulaire de fermeture."),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

// ─── CLOSE TICKET MODAL ───────────────────────────────────────────────────────

/**
 * BUG CORRIGÉ : closeTicketModalHandler était bien défini dans ce fichier
 * mais n'était pas exporté dans la version originale du document 3.
 * Il est maintenant correctement exporté en bas de ce fichier.
 */
const closeTicketModalHandler = {
  name: 'ticket_close_modal',

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'fermer ce ticket',
        { allowTicketCreator: true },
        2000,
      );
      if (!permissionCheck.success) {
        return await replyPermissionError(interaction, permissionCheck);
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      const reason = providedReason || 'Fermé via le bouton sans raison spécifique.';

      const result = await closeTicket(interaction.channel, interaction.user, reason);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket fermé', 'Ce ticket a été fermé.')],
        });
      } else {
        await interaction.editReply({
          embeds: [
            errorEmbed('Erreur', result.error || 'Impossible de fermer le ticket.'),
          ],
        });
      }
    } catch (error) {
      logger.error('Erreur modal fermeture ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [
            errorEmbed('Erreur', 'Une erreur est survenue lors de la fermeture.'),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          embeds: [
            errorEmbed('Erreur', 'Une erreur est survenue lors de la fermeture.'),
          ],
        });
      }
    }
  },
};

// ─── CLAIM TICKET ─────────────────────────────────────────────────────────────

const claimTicketHandler = {
  name: 'ticket_claim',

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'prendre en charge ce ticket',
        {},
        2000,
      );
      if (!permissionCheck.success) {
        return await replyPermissionError(interaction, permissionCheck);
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const result = await claimTicket(interaction.channel, interaction.user);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket pris en charge', 'Tu as pris en charge ce ticket !')],
        });
      } else {
        await interaction.editReply({
          embeds: [
            errorEmbed('Erreur', result.error || 'Impossible de prendre en charge le ticket.'),
          ],
        });
      }
    } catch (error) {
      logger.error('Erreur claim ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
        });
      }
    }
  },
};

// ─── PRIORITY TICKET ──────────────────────────────────────────────────────────

/**
 * BUG CORRIGÉ : La priorité vient de args[0] (passé par le dispatcher depuis
 * le customId, ex: "ticket_priority:high") et non d'une valeur fixe.
 */
const priorityTicketHandler = {
  name: 'ticket_priority',

  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'changer la priorité',
        {},
        2000,
      );
      if (!permissionCheck.success) {
        return await replyPermissionError(interaction, permissionCheck);
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const priority = args?.[0];
      if (!priority) {
        return await interaction.editReply({
          embeds: [errorEmbed('Priorité invalide', 'Une valeur de priorité est requise.')],
        });
      }

      const result = await updateTicketPriority(
        interaction.channel,
        priority,
        interaction.user,
      );

      if (result.success) {
        await interaction.editReply({
          embeds: [
            successEmbed(
              'Priorité mise à jour',
              `Priorité du ticket définie à **${priority}**.`,
            ),
          ],
        });
      } else {
        await interaction.editReply({
          embeds: [
            errorEmbed(
              'Erreur',
              result.error || 'Impossible de mettre à jour la priorité.',
            ),
          ],
        });
      }
    } catch (error) {
      logger.error('Erreur priorité ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
        });
      }
    }
  },
};

// ─── PIN TICKET ───────────────────────────────────────────────────────────────

const pinTicketHandler = {
  name: 'ticket_pin',

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'épingler ce ticket',
        {},
        2000,
      );
      if (!permissionCheck.success) {
        return await replyPermissionError(interaction, permissionCheck);
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const channel = interaction.channel;

      if (!channel.parent) {
        return await interaction.editReply({
          embeds: [errorEmbed('Erreur', "Ce ticket n'est pas dans une catégorie.")],
        });
      }

      const isPinned = channel.name.startsWith('📌');

      if (isPinned) {
        const newName = channel.name.replace(/^📌\s*/, '');
        await channel.edit({ name: newName, position: 999 });
        await interaction.editReply({
          embeds: [
            createEmbed({
              title: '📌 Ticket désépinglé',
              description: 'Ce ticket a été désépinglé.',
              color: 0x95a5a6,
            }),
          ],
        });
        logger.info('Ticket désépinglé', {
          guildId: interaction.guildId,
          channelId: channel.id,
        });
      } else {
        const newName = `📌 ${channel.name}`;
        await channel.edit({ name: newName, position: 0 });
        await interaction.editReply({
          embeds: [
            createEmbed({
              title: '📌 Ticket épinglé',
              description: 'Ce ticket a été épinglé en haut de la catégorie.',
              color: 0x3498db,
            }),
          ],
        });
        logger.info('Ticket épinglé', {
          guildId: interaction.guildId,
          channelId: channel.id,
        });
      }

      await logTicketEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        event: {
          type: isPinned ? 'unpin' : 'pin',
          ticketId: channel.id,
          ticketNumber: channel.name.replace(/[^0-9]/g, ''),
          userId: interaction.user.id,
          executorId: interaction.user.id,
          metadata: { isPinned: !isPinned },
        },
      });
    } catch (error) {
      logger.error('Erreur épinglage ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [
            errorEmbed('Erreur', "Impossible d'épingler/désépingler le ticket."),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          embeds: [
            errorEmbed('Erreur', "Impossible d'épingler/désépingler le ticket."),
          ],
        });
      }
    }
  },
};

// ─── UNCLAIM TICKET ───────────────────────────────────────────────────────────

const unclaimTicketHandler = {
  name: 'ticket_unclaim',

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'libérer ce ticket',
        {},
        2000,
      );
      if (!permissionCheck.success) {
        return await replyPermissionError(interaction, permissionCheck);
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const { unclaimTicket } = await import('../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket libéré', 'Tu as libéré ce ticket !')],
        });
      } else {
        await interaction.editReply({
          embeds: [
            errorEmbed('Erreur', result.error || 'Impossible de libérer le ticket.'),
          ],
        });
      }
    } catch (error) {
      logger.error('Erreur libération ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
        });
      }
    }
  },
};

// ─── REOPEN TICKET ────────────────────────────────────────────────────────────

const reopenTicketHandler = {
  name: 'ticket_reopen',

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'rouvrir ce ticket',
        {},
        2000,
      );
      if (!permissionCheck.success) {
        return await replyPermissionError(interaction, permissionCheck);
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const { reopenTicket } = await import('../services/ticket.js');
      const result = await reopenTicket(interaction.channel, interaction.member);

      if (result.success) {
        let message = 'Tu as rouvert ce ticket avec succès !';
        if (result.openCategoryMoveFailed) {
          message +=
            "\n\n⚠️ Le ticket a été rouvert mais n'a pas pu être déplacé dans la catégorie configurée.";
        }
        await interaction.editReply({
          embeds: [successEmbed('Ticket rouvert', message)],
        });
      } else {
        await interaction.editReply({
          embeds: [
            errorEmbed('Erreur', result.error || 'Impossible de rouvrir le ticket.'),
          ],
        });
      }
    } catch (error) {
      logger.error('Erreur réouverture ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
        });
      }
    }
  },
};

// ─── DELETE TICKET ────────────────────────────────────────────────────────────

const deleteTicketHandler = {
  name: 'ticket_delete',

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'supprimer ce ticket',
        {},
        2000,
      );
      if (!permissionCheck.success) {
        return await replyPermissionError(interaction, permissionCheck);
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const { deleteTicket } = await import('../services/ticket.js');
      const result = await deleteTicket(interaction.channel, interaction.member);

      if (result.success) {
        await interaction.editReply({
          embeds: [
            successEmbed(
              'Ticket supprimé',
              'Ce ticket sera définitivement supprimé dans 3 secondes.',
            ),
          ],
        });
      } else {
        await interaction.editReply({
          embeds: [
            errorEmbed('Erreur', result.error || 'Impossible de supprimer le ticket.'),
          ],
        });
      }
    } catch (error) {
      logger.error('Erreur suppression ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')],
        });
      }
    }
  },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

// Export par défaut : createTicketHandler (rétrocompatibilité)
export default createTicketHandler;

// Exports nommés : tous les autres handlers
export {
  createTicketModalHandler,
  closeTicketModalHandler,   // BUG CORRIGÉ : était absent dans la version originale du doc 3
  closeTicketHandler,
  claimTicketHandler,
  priorityTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler,
};
