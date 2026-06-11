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
        const sep = '──────────────────────';

        // EMBED 1 - DIRECTION
        const directionEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('👑 Pôle Direction RCTE 2026')
            .setDescription('Direction générale de la RCTE')
            .addFields(
                {
                    name: `${sep}`,
                    value: `${r('1473099567799996517')} **CEO :**\n› ${u('680436746286399559')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1473350291637407785')} **Co-CEO :**\n› ${u('705753810232016896')}\n› ${u('538695943151812619')}\n\u200B`,
                    inline: false,
                },
            )
            .setFooter({ text: 'RCTE © 2026' });

        // EMBED 2 - STAFF
        const staffEmbed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('🔨 Pôle Staff RCTE 2026')
            .setDescription('Liste des membres du staff de la RCTE pour 2026')
            .addFields(
                {
                    name: `${sep}`,
                    value: `${r('1473350434855977033')} **Super Modérateur :**\n| none\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1473350436621779176')} **Modérateur :**\n| none\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1473350439092355083')} **Modérateur Test :**\n| none\n\u200B`,
                    inline: false,
                },
            )
            .setFooter({ text: 'RCTE © 2026' });

        // EMBED 3 - JOUEURS
        const joueursEmbed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('🎮 Pôle Joueur RCTE 2026')
            .setDescription('Liste des joueurs, IGL et coach de la RCTE pour 2026')
            .addFields(
                {
                    name: `${sep}`,
                    value: `${r('1492192199109247067')} **Resp. Coaching :**\n| ${u('1233815813715136623')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1473099921191342090')} **Coach :**\n| none\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1473099888740007936')} **Joueurs :**\n| ${u('1140673917036527616')}\n| ${u('1393013002827206696')}\n| ${u('705753810232016896')}\n| ${u('538695943151812619')}\n| ${u('911592665836027905')}\n| ${u('1147481554914922518')}\n| ${u('680436746286399559')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1496941640101662810')} **IGL :**\n| ${u('680436746286399559')}\n\u200B`,
                    inline: false,
                },
            )
            .setFooter({ text: 'RCTE © 2026' });

        // EMBED 4 - MÉDIA
        const mediaEmbed = new EmbedBuilder()
            .setColor('#E91E63')
            .setTitle('🎬 Pôle Média RCTE 2026')
            .setDescription('Liste des membres du pôle média de la RCTE pour 2026')
            .addFields(
                {
                    name: `${sep}`,
                    value: `${r('1493943708377153667')} **Content Creator :**\n| ${u('1334592369936564385')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1474896104326828282')} **Graphiste :**\n| ${u('1202318610635169836')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1477471254146453514')} **Community Manager :**\n| ${u('705753810232016896')}\n| ${u('1202318610635169836')}\n| ${u('680436746286399559')}\n| ${u('1233815813715136623')}\n\u200B`,
                    inline: false,
                },
                {
                    name: `${sep}`,
                    value: `${r('1493943794838798356')} **Casteur :**\n| ${u('1334592369936564385')}\n\u200B`,
                    inline: false,
                },
            )
            .setFooter({ text: 'RCTE © 2026' });

        // EMBED 5 - REMERCIEMENTS
        const remercieEmbed = new EmbedBuilder()
            .setColor('#FF73FA')
            .setTitle('💜 Remerciements')
            .setDescription('Un grand merci à toutes les personnes qui soutiennent la RCTE !')
            .addFields(
                {
                    name: `${sep}`,
                    value: `${r('1512406759262916760')} **Server Boosters :**\n| ${u('705753810232016896')}\n\u200B`,
                    inline: false,
                },
                {
                    name: '\u200B',
                    value: '> *Merci à tous nos boosters qui nous aident à faire grandir la communauté RCTE* 💜',
                    inline: false,
                },
            )
            .setFooter({ text: 'RCTE © 2026' });

        try {
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [directionEmbed, staffEmbed, joueursEmbed, mediaEmbed, remercieEmbed],
            });
            logger.info(`[RCTE] Roster affiché par ${interaction.user.tag} dans ${interaction.guildId}`);
        } catch (error) {
            logger.error(`[RCTE] Erreur lors de l'affichage du roster:`, error);
        }
    },
};
