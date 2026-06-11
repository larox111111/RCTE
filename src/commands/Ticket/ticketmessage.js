import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { getGuildConfig } from '../../services/guildConfig.js';

// ─── Commande /ticketmessage ───────────────────────────────────────────────────
//
// Ouvre un modal multiligne pour modifier le message du panel de tickets.
// Supporte : sauts de ligne, mentions (@role, @user), markdown Discord (gras, italique…)
//
// IMPORTANT : Cette commande ne fait PAS de defer avant d'ouvrir le modal,
// car Discord interdit d'ouvrir un modal après un defer.
//
export default {
    data: new SlashCommandBuilder()
        .setName('ticketmessage')
        .setDescription('Modifier le message du panel de tickets (sauts de ligne, mentions, markdown)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .setDMPermission(false),

    category: 'ticket',

    async execute(interaction, config, client) {
        try {
            // Vérification permission
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return await interaction.reply({
                    content: '❌ Tu as besoin de la permission `Gérer les salons` pour utiliser cette commande.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Vérification que le système est configuré
            const guildConfig = await getGuildConfig(client, interaction.guildId);
            if (!guildConfig?.ticketPanelChannelId) {
                return await interaction.reply({
                    content: '❌ Aucun système de tickets configuré. Utilise `/ticket setup` d\'abord.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Ouvrir le modal avec le message actuel pré-rempli
            const currentMessage = guildConfig.ticketPanelMessage || 'Clique sur un bouton ci-dessous pour créer un ticket.';

            const modal = new ModalBuilder()
                .setCustomId('ticket_panel_message_modal')
                .setTitle('Message du panel de tickets');

            const messageInput = new TextInputBuilder()
                .setCustomId('panel_message')
                .setLabel('Message du panel')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(currentMessage.slice(0, 4000)) // pré-remplir avec le message actuel
                .setPlaceholder(
                    'Exemple :\n**Bienvenue !**\nMerci d\'utiliser les tickets.\n\nPing un rôle : <@&123456789>\nSauts de ligne supportés ✅',
                )
                .setRequired(true)
                .setMaxLength(4000);

            modal.addComponents(new ActionRowBuilder().addComponents(messageInput));

            await interaction.showModal(modal);

            logger.info(`[Ticket] Modal message panel ouvert par ${interaction.user.tag}`, {
                guildId: interaction.guildId,
                userId: interaction.user.id,
            });
        } catch (error) {
            logger.error('Erreur commande ticketmessage:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Une erreur est survenue.',
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
            }
        }
    },
};
