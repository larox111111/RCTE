import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getColor } from '../../config/bot.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

export default {
    data: new SlashCommandBuilder()
        .setName('rcte')
        .setDescription('Affiche le roster officiel de la RCTE'),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) return;

        const r = (id) => `<@&${id}>`;
        const u = (id) => `<@${id}>`;

        const embed = new EmbedBuilder()
            .setColor(getColor('primary'))
            .setTitle('🏆 Roster Officiel RCTE')
            .setTimestamp()
            .setFooter({ text: 'RCTE - Roster Officiel' })
            .addFields(
                // DIRECTION
                {
                    name: `${r('1473099567799996517')} — CEO`,
                    value: `› ${u('680436746286399559')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${r('1473350291637407785')} — Co-CEO`,
                    value: `› ${u('705753810232016896')}\n› ${u('538695943151812619')}\n\u200B`,
                    inline: false,
                },

                // STAFF
                {
                    name: `━━━━━━━━━━━━━━━━━━━━\n${r('1495760936315785227')}`,
                    value: `\u200B`,
                    inline: false,
                },
                {
                    name: `${r('1473350434855977033')} — Super Modérateur`,
                    value: `› Aucun membre\n\u200B`,
                    inline: false,
                },
                {
                    name: `${r('1473350436621779176')} — Modérateur`,
                    value: `› Aucun membre\n\u200B`,
                    inline: false,
                },

                // MODÉRATEUR TEST
                {
                    name: `━━━━━━━━━━━━━━━━━━━━\n${r('1473350439092355083')} — Modérateur Test`,
                    value: `› Aucun membre\n\u200B`,
                    inline: false,
                },

                // COACHING
                {
                    name: `━━━━━━━━━━━━━━━━━━━━\n${r('1492192199109247067')} — Resp. Coaching`,
                    value: `› ${u('1233815813715136623')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${r('1473099921191342090')} — Coach`,
                    value: `› Aucun membre\n\u200B`,
                    inline: false,
                },

                // JOUEURS
                {
                    name: `━━━━━━━━━━━━━━━━━━━━\n${r('1473099888740007936')} — Joueurs`,
                    value: [
                        `› ${u('1140673917036527616')}`,
                        `› ${u('1393013002827206696')}`,
                        `› ${u('705753810232016896')}`,
                        `› ${u('538695943151812619')}`,
                        `› ${u('911592665836027905')}`,
                        `› ${u('1147481554914922518')}`,
                        `› ${u('680436746286399559')}`,
                        '\u200B',
                    ].join('\n'),
                    inline: false,
                },

                // RÔLES SPÉCIAUX
                {
                    name: `━━━━━━━━━━━━━━━━━━━━\n${r('1496941640101662810')} — IGL`,
                    value: `› ${u('680436746286399559')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${r('1493943708377153667')} — Content Creator`,
                    value: `› ${u('1334592369936564385')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${r('1474896104326828282')} — Graphiste`,
                    value: `› ${u('1202318610635169836')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${r('1477471254146453514')} — Community Manager`,
                    value: [
                        `› ${u('705753810232016896')}`,
                        `› ${u('1202318610635169836')}`,
                        `› ${u('680436746286399559')}`,
                        `› ${u('1233815813715136623')}`,
                        '\u200B',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: `${r('1493943794838798356')} — Casteur`,
                    value: `› ${u('1334592369936564385')}\n\u200B`,
                    inline: false,
                },

                // BOOSTERS
                {
                    name: `━━━━━━━━━━━━━━━━━━━━`,
                    value: `\u200B`,
                    inline: false,
                },
                {
                    name: `💜 Merci à nos Server Boosters !`,
                    value: `› ${r('1512406759262916760')}\n\u200B\n› ${u('705753810232016896')}\n\u200B`,
                    inline: false,
                },
            );

        try {
            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            logger.info(`[RCTE] Roster affiché par ${interaction.user.tag} dans ${interaction.guildId}`);
        } catch (error) {
            logger.error(`[RCTE] Erreur lors de l'affichage du roster:`, error);
        }
    },
};
