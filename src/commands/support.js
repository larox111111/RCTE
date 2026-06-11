import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { errorEmbed } from '../../utils/embeds.js';

export default {
    data: new SlashCommandBuilder()
        .setName('supporter')
        .setDescription('Rejoins les supporters de la RCTE !'),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { ephemeral: true });
        if (!deferSuccess) return;

        const role = interaction.guild.roles.cache.get('1514538458800980069');

        if (!role) {
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Erreur', 'Le rôle RCTE Supporter est introuvable.')],
            });
        }

        try {
            if (interaction.member.roles.cache.has(role.id)) {
                await interaction.member.roles.remove(role);
                logger.info(`[Support] ${interaction.user.tag} a retiré le rôle RCTE Supporter`);
                return InteractionHelper.safeEditReply(interaction, {
                    content: '❌ Tu n\'es plus un RCTE Supporter.',
                });
            }

            await interaction.member.roles.add(role);
            logger.info(`[Support] ${interaction.user.tag} a obtenu le rôle RCTE Supporter`);
            await InteractionHelper.safeEditReply(interaction, {
                content: '💜 Tu es maintenant un **RCTE Supporter** ! Merci pour ton soutien !',
            });
        } catch (error) {
            logger.error(`[Support] Erreur:`, error);
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Erreur', 'Impossible d\'attribuer le rôle. Vérifie mes permissions.')],
            });
        }
    },
};
