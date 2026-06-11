import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../utils/embeds.js';
import { createTicket, closeTicket, claimTicket, updateTicketPriority } from '../services/ticket.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logTicketEvent } from '../utils/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { getTicketPermissionContext } from '../utils/ticketPermissions.js';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) return true;
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      embeds: [errorEmbed('Serveur uniquement', 'Cette action ne peut être utilisée que dans un serveur.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  return false;
}

async function checkTicketPermissionWithTimeout(interaction, client, actionLabel, options = {}, timeoutMs = 2500) {
  const { allowTicketCreator = false } = options;
  try {
    const contextPromise = getTicketPermissionContext({ client, interaction });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    );
    const context = await Promise.race([contextPromise, timeoutPromise]);
    if (!context.ticketData) {
      return { success: false, error: 'Pas un salon ticket', details: 'Cette action ne peut être utilisée que dans un salon ticket valide.' };
    }
    const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
    if (!allowed) {
      const permissionMessage = allowTicketCreator
        ? 'Tu dois avoir la permission **Gérer les salons**, le **rôle Staff** configuré, ou être le **créateur du ticket**.'
        : 'Tu dois avoir la permission **Gérer les salons** ou le **rôle Staff** configuré.';
      return { success: false, error: 'Permission refusée', details: `${permissionMessage}\n\nTu ne peux pas ${actionLabel}.` };
    }
    return { success: true, context };
  } catch (error) {
    if (error.message === 'Timeout') {
      return { success: false, error: 'Délai dépassé', details: 'La vérification des permissions a pris trop de temps. Réessaie.' };
    }
    return { success: false, error: 'Erreur', details: `Impossible de vérifier les permissions : ${error.message}` };
  }
}

async function ensureTicketPermission(interaction, client, actionLabel, options = {}) {
  const { allowTicketCreator = false } = options;
  const context = await getTicketPermissionContext({ client, interaction });
  if (!context.ticketData) {
    await interaction.reply({
      embeds: [errorEmbed('Pas un salon ticket', 'Cette action ne peut être utilisée que dans un salon ticket valide.')],
      flags: MessageFlags.Ephemeral
    });
    return null;
  }
  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'Tu dois avoir la permission **Gérer les salons**, le **rôle Staff** configuré, ou être le **créateur du ticket**.'
      : 'Tu dois avoir la permission **Gérer les salons** ou le **rôle Staff** configuré.';
    await interaction.reply({
      embeds: [errorEmbed('Permission refusée', `${permissionMessage}\n\nTu ne peux pas ${actionLabel}.`)],
      flags: MessageFlags.Ephemeral
    });
    return null;
  }
  return context;
}

// ─── CREATE TICKET HANDLER ────────────────────────────────────────────────────

const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60000);
      if (!allowed) {
        await interaction.reply({
          embeds: [errorEmbed('Limite atteinte', 'Tu crées des tickets trop rapidement. Attends une minute et réessaie.')],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;

      const { getUserTicketCount } = await import('../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);

      if (currentTicketCount >= maxTicketsPerUser) {
        return await interaction.reply({
          embeds: [errorEmbed(
            '🎫 Limite de tickets atteinte',
            `Tu as atteint le nombre maximum de tickets ouverts (${maxTicketsPerUser}).\n\nFerme tes tickets existants avant d'en créer un nouveau.\n\n**Tickets actuels :** ${currentTicketCount}/${maxTicketsPerUser}`
          )],
          flags: MessageFlags.Ephemeral
        });
      }

      // Récupérer le type de ticket selon le bouton cliqué
      const customId = interaction.customId;
      const buttonIndex = customId === 'create_ticket' ? 0 : parseInt(customId.split('_').pop());
      const ticketButtons = config.ticketButtons || [{ label: config.ticketButtonLabel || 'Créer un ticket', emoji: '📩' }];
      const ticketType = ticketButtons[buttonIndex]?.label || 'Ticket';

      const modal = new ModalBuilder()
        .setCustomId(`create_ticket_modal_${buttonIndex}`)
        .setTitle(ticketType);

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Pourquoi tu crées ce ticket ?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Décris ton problème ou ta demande...')
        .setRequired(true)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Erreur création modal ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Erreur', 'Impossible d\'ouvrir le formulaire de création de ticket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
};

const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;

      // Récupérer l'index du bouton depuis le customId du modal
      const modalCustomId = interaction.customId;
      const buttonIndex = modalCustomId === 'create_ticket_modal' ? 0 : parseInt(modalCustomId.split('_').pop());
      const ticketButtons = config.ticketButtons || [{ label: config.ticketButtonLabel || 'Ticket', emoji: '📩' }];
      const ticketType = ticketButtons[buttonIndex]?.label || 'Ticket';

      const result = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
        'none',
        ticketType
      );

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('✅ Ticket créé !', `Ton ticket a été créé dans ${result.channel} !`)]
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', result.error || 'Impossible de créer le ticket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Erreur création ticket:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Erreur', 'Une erreur est survenue lors de la création du ticket.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};

// ─── CLOSE TICKET ─────────────────────────────────────────────────────────────

const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'fermer ce ticket', { allowTicketCreator: true }, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const modal = new ModalBuilder().setCustomId('ticket_close_modal').setTitle('Fermer le ticket');
      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Raison de la fermeture (optionnel)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Ajoute une raison optionnelle...')
        .setRequired(false)
        .setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Erreur fermeture ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Erreur', 'Impossible d\'ouvrir le formulaire de fermeture.')], flags: MessageFlags.Ephemeral });
      }
    }
  }
};

const closeTicketModalHandler = {
  name: 'ticket_close_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'fermer ce ticket', { allowTicketCreator: true }, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      const reason = providedReason || 'Fermé via le bouton sans raison spécifique.';
      const result = await closeTicket(interaction.channel, interaction.user, reason);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Ticket fermé', 'Ce ticket a été fermé.')], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error || 'Impossible de fermer le ticket.')], flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      logger.error('Erreur modal fermeture ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue lors de la fermeture.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue lors de la fermeture.')], flags: MessageFlags.Ephemeral });
      }
    }
  }
};

// ─── CLAIM TICKET ─────────────────────────────────────────────────────────────

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'prendre en charge ce ticket', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const result = await claimTicket(interaction.channel, interaction.user);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Ticket pris en charge', 'Tu as pris en charge ce ticket !')], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error || 'Impossible de prendre en charge le ticket.')], flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      logger.error('Erreur claim ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      }
    }
  }
};

// ─── PRIORITY TICKET ──────────────────────────────────────────────────────────

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'changer la priorité', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const priority = args?.[0];
      if (!priority) {
        await interaction.editReply({ embeds: [errorEmbed('Priorité invalide', 'Une valeur de priorité est requise.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const result = await updateTicketPriority(interaction.channel, priority, interaction.user);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Priorité mise à jour', `Priorité du ticket définie à ${priority}.`)], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error || 'Impossible de mettre à jour la priorité.')], flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      logger.error('Erreur priorité ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      }
    }
  }
};

// ─── PIN TICKET ───────────────────────────────────────────────────────────────

const pinTicketHandler = {
  name: 'ticket_pin',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'épingler ce ticket', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const channel = interaction.channel;
      const category = channel.parent;
      if (!category) {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Ce ticket n\'est pas dans une catégorie.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const hasPingEmoji = channel.name.startsWith('📌');
      if (hasPingEmoji) {
        const newName = channel.name.replace(/^📌\s*/, '');
        await channel.edit({ name: newName, position: 999 });
        await interaction.editReply({ embeds: [createEmbed({ title: '📌 Ticket désépinglé', description: 'Ce ticket a été désépinglé.', color: 0x95A5A6 })], flags: MessageFlags.Ephemeral });
        logger.info('Ticket désépinglé', { guildId: interaction.guildId, channelId: channel.id });
      } else {
        const newName = `📌 ${channel.name}`;
        await channel.edit({ name: newName, position: 0 });
        await interaction.editReply({ embeds: [createEmbed({ title: '📌 Ticket épinglé', description: 'Ce ticket a été épinglé en haut de la catégorie.', color: 0x3498db })], flags: MessageFlags.Ephemeral });
        logger.info('Ticket épinglé', { guildId: interaction.guildId, channelId: channel.id });
      }
      await logTicketEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        event: {
          type: hasPingEmoji ? 'unpin' : 'pin',
          ticketId: channel.id,
          ticketNumber: channel.name.replace(/[^0-9]/g, ''),
          userId: interaction.user.id,
          executorId: interaction.user.id,
          metadata: { isPinned: !hasPingEmoji }
        }
      });
    } catch (error) {
      logger.error('Erreur épinglage ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Erreur', 'Impossible d\'épingler/désépingler le ticket.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Impossible d\'épingler/désépingler le ticket.')], flags: MessageFlags.Ephemeral });
      }
    }
  }
};

// ─── UNCLAIM TICKET ───────────────────────────────────────────────────────────

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'libérer ce ticket', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const { unclaimTicket } = await import('../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Ticket libéré', 'Tu as libéré ce ticket !')], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error || 'Impossible de libérer le ticket.')], flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      logger.error('Erreur libération ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      }
    }
  }
};

// ─── REOPEN TICKET ────────────────────────────────────────────────────────────

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'rouvrir ce ticket', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const { reopenTicket } = await import('../services/ticket.js');
      const result = await reopenTicket(interaction.channel, interaction.member);
      if (result.success) {
        let reopenMessage = 'Tu as rouvert ce ticket avec succès !';
        if (result.openCategoryMoveFailed) {
          reopenMessage += '\n\n⚠️ Le ticket a été rouvert mais n\'a pas pu être déplacé dans la catégorie configurée.';
        }
        await interaction.editReply({ embeds: [successEmbed('Ticket rouvert', reopenMessage)], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error || 'Impossible de rouvrir le ticket.')], flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      logger.error('Erreur réouverture ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      }
    }
  }
};

// ─── DELETE TICKET ────────────────────────────────────────────────────────────

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      const permissionCheck = await checkTicketPermissionWithTimeout(interaction, client, 'supprimer ce ticket', {}, 2000);
      if (!permissionCheck.success) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ embeds: [errorEmbed(permissionCheck.error, permissionCheck.details)], flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      const { deleteTicket } = await import('../services/ticket.js');
      const result = await deleteTicket(interaction.channel, interaction.member);
      if (result.success) {
        await interaction.editReply({ embeds: [successEmbed('Ticket supprimé', 'Ce ticket sera définitivement supprimé dans 3 secondes.')], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error || 'Impossible de supprimer le ticket.')], flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      logger.error('Erreur suppression ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue.')], flags: MessageFlags.Ephemeral });
      }
    }
  }
};

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
  deleteTicketHandler
};
