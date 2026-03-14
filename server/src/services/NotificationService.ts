import { GatewayService } from './GatewayService';

export interface Notification {
    type: 'info' | 'warning' | 'error' | 'success';
    title?: string;
    message: string;
    actions?: Array<{ label: string; action: string; params?: any }>;
}

/**
 * NotificationService - Sends notifications via the Gateway
 */
export class NotificationService {
    private gateway: GatewayService;

    constructor(gateway: GatewayService) {
        this.gateway = gateway;
    }

    async send(notification: Notification) {
        console.log('[Notification]', notification);
        this.gateway.emitNotification(
            notification.type,
            notification.title || '',
            notification.message
        );
    }

    async sendError(title: string, error: any) {
        const message = error instanceof Error ? error.message : String(error);
        await this.send({
            type: 'error',
            title,
            message,
        });
    }

    async sendSuccess(title: string, message: string) {
        await this.send({
            type: 'success',
            title,
            message
        });
    }

    async sendWarning(title: string, message: string) {
        await this.send({
            type: 'warning',
            title,
            message
        });
    }
}
