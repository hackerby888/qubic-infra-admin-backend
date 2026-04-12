import nodemailer from "nodemailer";
import { logger } from "./logger.js";

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
});

export namespace Gmail {
    export function sendEmail(mailOptions: nodemailer.SendMailOptions) {
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                return logger.error("Error occurred: " + error.message);
            }
            logger.info(
                "Email sent successfully! " + "Message ID: " + info.messageId
            );
        });
    }

    export function sendNodeStatusEmail({
        to,
        nodeIp,
        behindTicks,
    }: {
        to: string;
        nodeIp: string;
        behindTicks: number;
    }) {
        const options: nodemailer.SendMailOptions = {
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: to,
            subject: `Main node ${nodeIp} is lagging ${behindTicks} behind!`,
            text: `The main node at IP ${nodeIp} is lagging behind by ${behindTicks} ticks. Please check the node status.`,
            html: `<b>The main node at IP ${nodeIp}</b> is lagging behind by <i>${behindTicks}</i> ticks. Please check the node status.`,
        };
        sendEmail(options);
    }
}
