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

async function replyPermissionError(interaction, permissionCheck) {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ─── CREATE TICKET (bouton) ───────────────────────────────────────────────────

const createTicketHandler = {
  name: 'create_ticket',

  match(customId) {
    return customId === 'create_ticket' || /^create_ticket_\d+$/.test(customId);
  },

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

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

      const customId = interaction.customId;
      const buttonIndex =
        customId === 'create_ticket' ? 0 : parseInt(customId.split('_').pop(), 10);

      const ticketButtons = config.ticketButtons || [
        { label: config.ticketButtonLabel || 'Créer un ticket', emoji: '📩', roleId: null },
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

      const modalCustomId = interaction.customId;
      const buttonIndex =
        modalCustomId === 'create_ticket_modal'
          ? 0
          : parseInt(modalCustomId.split('_').pop(), 10);

      const ticketButtons = config.ticketButtons || [
        { label: config.ticketButtonLabel || 'Ticket', emoji: '📩', roleId: null },
      ];
      const ticketType = ticketButtons[buttonIndex]?.label || 'Ticket';
      // ← AJOUT : récupération du roleId du bouton cliqué
      const buttonRoleId = ticketButtons[buttonIndex]?.roleId || null;

      const result = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
        'none',
        ticketType,
        buttonRoleId, // ← transmis à createTicket
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

// ─── TICKET PANEL MESSAGE MODAL ───────────────────────────────────────────────

import { EmbedBuilder as _EmbedBuilder } from 'discord.js';
import { getGuildConfig as _getGuildConfig } from '../services/guildConfig.js';
import { getGuildConfigKey as _getGuildConfigKey } from '../utils/database.js';
import { getColor as _getColor } from '../config/bot.js';

const ticketPanelMessageModalHandler = {
  name: 'ticket_panel_message_modal',

  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // Vérification permission
      if (!interaction.member.permissions.has(0x10)) { // ManageChannels
        return await interaction.reply({
          embeds: [errorEmbed('Permission refusée', "Tu as besoin de la permission `Gérer les salons`.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, {
        flags: MessageFlags.Ephemeral,
      });
      if (!deferSuccess) return;

      const newMessage = interaction.fields.getTextInputValue('panel_message').trim();
      if (!newMessage) {
        return await interaction.editReply({
          embeds: [errorEmbed('Message vide', 'Le message du panel ne peut pas être vide.')],
        });
      }

      const guildConfig = await _getGuildConfig(client, interaction.guildId);
      if (!guildConfig?.ticketPanelChannelId) {
        return await interaction.editReply({
          embeds: [errorEmbed('Système non configuré', "Aucun système de tickets configuré.")],
        });
      }

      // Mettre à jour la config
      guildConfig.ticketPanelMessage = newMessage;
      await client.db.set(_getGuildConfigKey(interaction.guildId), guildConfig);

      // Mettre à jour le panel live
      let panelUpdated = false;
      try {
        const channel = await interaction.guild.channels.fetch(guildConfig.ticketPanelChannelId).catch(() => null);
        if (channel) {
          const messages = await channel.messages.fetch({ limit: 50 });
          const panelMsg = messages.find(
            (m) =>
              m.author.id === client.user.id &&
              m.components?.length > 0 &&
              m.components[0]?.components?.[0]?.customId?.startsWith('create_ticket'),
          );
          if (panelMsg) {
            const updatedEmbed = new _EmbedBuilder()
              .setTitle('🎫 Tickets Support')
              .setDescription(newMessage)
              .setColor(_getColor('info'));
            await panelMsg.edit({ embeds: [updatedEmbed], components: panelMsg.components });
            panelUpdated = true;
          }
        }
      } catch (updateError) {
        logger.warn('Impossible de mettre à jour le panel live:', updateError.message);
      }

      logger.info(`[Ticket] Message panel mis à jour par ${interaction.user.tag}`, {
        guildId: interaction.guildId,
      });

      await interaction.editReply({
        embeds: [
          successEmbed(
            '✅ Message mis à jour !',
            `Le message du panel a été modifié.${
              panelUpdated
                ? '\nLe panel a été mis à jour en direct.'
                : "\n> Le panel n'a pas pu être mis à jour automatiquement."
            }`,
          ),
        ],
      });
    } catch (error) {
      logger.error('Erreur modal message panel ticket:', error);
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

export default createTicketHandler;

export {
  createTicketModalHandler,
  closeTicketModalHandler,
  closeTicketHandler,
  claimTicketHandler,
  priorityTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler,
  ticketPanelMessageModalHandler,
};
