import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

export default {
    data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('Make the bot send a message')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addStringOption(option =>
            option.setName('message')
                .setDescription('The message to send')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Channel to send the message in (default: current channel)')
                .setRequired(false)),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { ephemeral: true });
        if (!deferSuccess) return;

        const message = interaction.options.getString('message');
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;

        if (!channel.isTextBased()) {
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Invalid Channel', 'The selected channel must be a text channel.')],
            });
        }

        try {
            await channel.send(message);
            logger.info(`[Say] ${interaction.user.tag} sent message in #${channel.name} (${interaction.guildId})`);

            await InteractionHelper.safeEditReply(interaction, {
                content: `✅ Message sent in ${channel}.`,
            });
        } catch (error) {
            logger.error(`[Say] Failed to send message in ${channel.id}:`, error);
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Send Failed', 'Could not send the message. Check my permissions in that channel.')],
            });
        }
    },
};
