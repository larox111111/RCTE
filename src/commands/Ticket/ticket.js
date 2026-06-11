import { getColor } from '../../config/bot.js';
import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { getGuildConfigKey } from '../../utils/database.js';
import ticketConfig from './modules/ticket_dashboard.js';

// ─── Helper : construit la rangée de boutons du panel ─────────────────────────
function buildPanelButtons(ticketButtons) {
    const buttons = ticketButtons.map((btn, index) =>
        new ButtonBuilder()
            .setCustomId(`create_ticket_${index}`)
            .setLabel(btn.label)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(btn.emoji || '📩'),
    );
    return new ActionRowBuilder().addComponents(buttons);
}

// ─── Helper : met à jour le panel live ────────────────────────────────────────
async function updateLivePanel(client, guild, config) {
    if (!config.ticketPanelChannelId) return false;
    try {
        const channel = await guild.channels.fetch(config.ticketPanelChannelId).catch(() => null);
        if (!channel) return false;

        const messages = await channel.messages.fetch({ limit: 50 });
        const panelMsg = messages.find(
            (m) =>
                m.author.id === client.user.id &&
                m.components?.length > 0 &&
                m.components[0]?.components?.[0]?.customId?.startsWith('create_ticket'),
        );
        if (!panelMsg) return false;

        const ticketButtons = config.ticketButtons || [
            { label: config.ticketButtonLabel || 'Créer un ticket', emoji: '📩' },
        ];

        const updatedEmbed = new EmbedBuilder()
            .setTitle('🎫 Tickets Support')
            .setDescription(
                config.ticketPanelMessage || 'Clique sur un bouton ci-dessous pour créer un ticket.',
            )
            .setColor(getColor('info'));

        const row = buildPanelButtons(ticketButtons);

        await panelMsg.edit({ embeds: [updatedEmbed], components: [row] });
        return true;
    } catch (error) {
        logger.warn('Impossible de mettre à jour le panel:', error.message);
        return false;
    }
}

// ─── Commande principale ──────────────────────────────────────────────────────
export default {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Gère le système de tickets du serveur.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('setup')
                .setDescription('Configure le panel de création de tickets.')
                .addChannelOption((option) =>
                    option
                        .setName('salon')
                        .setDescription('Le salon où envoyer le panel de tickets.')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('message')
                        .setDescription('Le message affiché sur le panel.')
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('premier_bouton')
                        .setDescription('Le label du premier bouton (défaut: Créer un ticket)')
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName('categorie')
                        .setDescription('La catégorie où créer les tickets.')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName('categorie_fermee')
                        .setDescription('La catégorie où déplacer les tickets fermés.')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addRoleOption((option) =>
                    option
                        .setName('role_staff')
                        .setDescription('Le rôle ayant accès aux tickets.')
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    option
                        .setName('max_tickets')
                        .setDescription('Nombre maximum de tickets par utilisateur (défaut: 3)')
                        .setMinValue(1)
                        .setMaxValue(10)
                        .setRequired(false),
                )
                .addBooleanOption((option) =>
                    option
                        .setName('dm_fermeture')
                        .setDescription(
                            "Envoyer un DM à l'utilisateur à la fermeture du ticket (défaut: oui)",
                        )
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('ajouterbouton')
                .setDescription('Ajouter un bouton au panel de tickets (max 5)')
                .addStringOption((option) =>
                    option
                        .setName('label')
                        .setDescription('Nom du bouton (ex: Recrutement Staff)')
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('emoji')
                        .setDescription('Emoji du bouton (ex: 📋)')
                        .setRequired(false),
                )
                .addRoleOption((option) =>
                    option
                        .setName('role')
                        .setDescription('Rôle qui aura accès à ces tickets (laisse vide = rôle staff global)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('supprimerbouton')
                .setDescription('Supprimer un bouton du panel de tickets')
                .addStringOption((option) =>
                    option
                        .setName('label')
                        .setDescription('Nom du bouton à supprimer')
                        .setRequired(true),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('dashboard')
                .setDescription('Ouvrir le tableau de bord du système de tickets'),
        ),

    category: 'ticket',

    async execute(interaction, config, client) {
        try {
            const deferred = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferred) return;

            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        errorEmbed(
                            'Permission refusée',
                            "Tu as besoin de la permission `Gérer les salons` pour utiliser cette commande.",
                        ),
                    ],
                });
            }

            const subcommand = interaction.options.getSubcommand();

            // ── Dashboard ────────────────────────────────────────────────────
            if (subcommand === 'dashboard') {
                return ticketConfig.execute(interaction, config, client);
            }

            // ── Setup ────────────────────────────────────────────────────────
            if (subcommand === 'setup') {
                const existingConfig = await getGuildConfig(client, interaction.guildId);

                if (existingConfig?.ticketPanelChannelId) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Système de tickets déjà actif',
                                `Un système de tickets est déjà configuré dans <#${existingConfig.ticketPanelChannelId}>.\n\nUtilise \`/ticket dashboard\` pour le modifier, ou **Supprimer le système** pour recommencer.`,
                            ),
                        ],
                    });
                }

                const panelChannel = interaction.options.getChannel('salon');
                const categoryChannel = interaction.options.getChannel('categorie');
                const closedCategoryChannel = interaction.options.getChannel('categorie_fermee');
                const staffRole = interaction.options.getRole('role_staff');
                const panelMessage =
                    interaction.options.getString('message') ||
                    'Clique sur un bouton ci-dessous pour créer un ticket.';
                const buttonLabel =
                    interaction.options.getString('premier_bouton') || 'Créer un ticket';
                const maxTicketsPerUser = interaction.options.getInteger('max_tickets') || 3;
                const dmOnClose = interaction.options.getBoolean('dm_fermeture') !== false;

                const ticketButtons = [{ label: buttonLabel, emoji: '📩', roleId: null }];

                const setupEmbed = createEmbed({
                    title: '🎫 Tickets Support',
                    description: panelMessage,
                    color: getColor('info'),
                });

                const row = buildPanelButtons(ticketButtons);

                try {
                    await panelChannel.send({ embeds: [setupEmbed], components: [row] });

                    existingConfig.ticketCategoryId = categoryChannel?.id || null;
                    existingConfig.ticketClosedCategoryId = closedCategoryChannel?.id || null;
                    existingConfig.ticketStaffRoleId = staffRole?.id || null;
                    existingConfig.ticketPanelChannelId = panelChannel.id;
                    existingConfig.ticketPanelMessage = panelMessage;
                    existingConfig.ticketButtonLabel = buttonLabel;
                    existingConfig.ticketButtons = ticketButtons;
                    existingConfig.maxTicketsPerUser = maxTicketsPerUser;
                    existingConfig.dmOnClose = dmOnClose;

                    await client.db.set(getGuildConfigKey(interaction.guildId), existingConfig);

                    logger.info('Ticket configuré', { guildId: interaction.guildId });

                    await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            successEmbed(
                                '✅ Panel de tickets configuré !',
                                `Le panel a été envoyé dans ${panelChannel}.\n\n**Max tickets/utilisateur :** ${maxTicketsPerUser}\n**DM à la fermeture :** ${dmOnClose ? 'Oui' : 'Non'}\n\nUtilise \`/ticket ajouterbouton\` pour ajouter d'autres boutons.`,
                            ),
                        ],
                    });
                } catch (error) {
                    logger.error('Erreur setup ticket:', error);
                    await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Échec de la configuration',
                                "Impossible d'envoyer le panel. Vérifie mes permissions dans ce salon.",
                            ),
                        ],
                    });
                }
            }

            // ── Ajouter bouton ───────────────────────────────────────────────
            if (subcommand === 'ajouterbouton') {
                const guildConfig = await getGuildConfig(client, interaction.guildId);

                if (!guildConfig?.ticketPanelChannelId) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Système non configuré',
                                "Configure d'abord le système de tickets avec `/ticket setup`.",
                            ),
                        ],
                    });
                }

                const label = interaction.options.getString('label').trim();
                const emoji = interaction.options.getString('emoji')?.trim() || '📩';
                // ← AJOUT : récupération du rôle spécifique au bouton
                const role = interaction.options.getRole('role');
                const roleId = role?.id || null;

                const ticketButtons = guildConfig.ticketButtons || [
                    { label: guildConfig.ticketButtonLabel || 'Créer un ticket', emoji: '📩', roleId: null },
                ];

                if (ticketButtons.length >= 5) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Limite atteinte',
                                "Tu ne peux pas avoir plus de 5 boutons sur le panel.",
                            ),
                        ],
                    });
                }

                if (ticketButtons.find((b) => b.label.toLowerCase() === label.toLowerCase())) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Bouton déjà existant',
                                `Un bouton avec le nom **${label}** existe déjà.`,
                            ),
                        ],
                    });
                }

                // ← AJOUT : roleId sauvegardé dans le bouton
                ticketButtons.push({ label, emoji, roleId });
                guildConfig.ticketButtons = ticketButtons;
                await client.db.set(getGuildConfigKey(interaction.guildId), guildConfig);

                const panelUpdated = await updateLivePanel(client, interaction.guild, guildConfig);

                logger.info(`[Ticket] Bouton ajouté: ${label} (role: ${roleId ?? 'staff global'}) par ${interaction.user.tag}`);

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            '✅ Bouton ajouté !',
                            `Le bouton **${emoji} ${label}** a été ajouté au panel.${
                                role ? `\n**Rôle associé :** ${role}` : '\n**Rôle :** staff global'
                            }${
                                panelUpdated
                                    ? '\nLe panel a été mis à jour.'
                                    : "\n> Le panel n'a pas pu être mis à jour automatiquement."
                            }`,
                        ),
                    ],
                });
            }

            // ── Supprimer bouton ─────────────────────────────────────────────
            if (subcommand === 'supprimerbouton') {
                const guildConfig = await getGuildConfig(client, interaction.guildId);

                if (!guildConfig?.ticketPanelChannelId) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Système non configuré',
                                "Configure d'abord le système de tickets avec `/ticket setup`.",
                            ),
                        ],
                    });
                }

                const label = interaction.options.getString('label').trim();
                const ticketButtons = guildConfig.ticketButtons || [
                    { label: guildConfig.ticketButtonLabel || 'Créer un ticket', emoji: '📩', roleId: null },
                ];

                if (ticketButtons.length <= 1) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Impossible',
                                "Tu ne peux pas supprimer le dernier bouton. Il doit en rester au moins un.",
                            ),
                        ],
                    });
                }

                const index = ticketButtons.findIndex(
                    (b) => b.label.toLowerCase() === label.toLowerCase(),
                );
                if (index === -1) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Bouton introuvable',
                                `Aucun bouton avec le nom **${label}** n'a été trouvé.\n\nBoutons actuels : ${ticketButtons.map((b) => `**${b.label}**`).join(', ')}`,
                            ),
                        ],
                    });
                }

                ticketButtons.splice(index, 1);
                guildConfig.ticketButtons = ticketButtons;
                await client.db.set(getGuildConfigKey(interaction.guildId), guildConfig);

                const panelUpdated = await updateLivePanel(client, interaction.guild, guildConfig);

                logger.info(`[Ticket] Bouton supprimé: ${label} par ${interaction.user.tag}`);

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            '✅ Bouton supprimé !',
                            `Le bouton **${label}** a été supprimé du panel.${
                                panelUpdated
                                    ? '\nLe panel a été mis à jour.'
                                    : "\n> Le panel n'a pas pu être mis à jour automatiquement."
                            }`,
                        ),
                    ],
                });
            }
        } catch (error) {
            logger.error('Erreur commande ticket:', error);
            await handleInteractionError(interaction, error, {
                commandName: 'ticket',
                source: 'ticket_command_main',
            });
        }
    },
};
