/* eslint-disable max-classes-per-file */
import { Context, ContextFactoryOptions, ContextDefaultState } from './context';

import { Params } from '../../api';
import { VKError } from '../../errors';

import { MessageReply, IMessageReplyPayload } from '../shared/message-reply';
import { MessageForward, IMessageForwardPayload } from '../shared/message-forward';
import { transformMessage } from '../../updates/transform-message';
import { MessageForwardsCollection } from '../shared/message-forwards-collection';

import { Attachment, ExternalAttachment } from '../attachments';
import { Attachmentable, IAllAttachmentable } from '../shared/attachmentable';

import { transformAttachments } from '../attachments/helpers';
import {
	unescapeHTML,
	pickProperties,
	getPeerType,
	applyMixins,
	getRandomId
} from '../../utils/helpers';
import {
	UpdateSource,
	MessageSource,
	CHAT_PEER,
	AttachmentType,
	kSerializeData,
	AttachmentTypeString
} from '../../utils/constants';
import { AllowArray } from '../../types';
import { KeyboardBuilder } from '../keyboard';
import { IUploadSourceMedia } from '../../upload';

export type MessageContextType = 'message';

type MessageContextPayloadEventType =
'chat_photo_update'
| 'chat_photo_remove'
| 'chat_create'
| 'chat_title_update'
| 'chat_invite_user'
| 'chat_kick_user'
| 'chat_pin_message'
| 'chat_unpin_message'
| 'chat_invite_user_by_link';

export type MessageContextSubType =
'message_new'
| 'message_edit'
| 'message_reply'
| MessageContextPayloadEventType;

const subTypesEnum: Record<string | number, MessageContextSubType> = {
	4: 'message_new',
	5: 'message_edit'
};

const kForwards = Symbol('forwards');
const kReplyMessage = Symbol('replyMessage');
const kMessagePayload = Symbol('messagePayload');

const kAttachments = Symbol('attachments');

export interface IMessageContextSendOptions extends Params.MessagesSendParams {
	attachment?: AllowArray<Attachment | string>;
	keyboard?: KeyboardBuilder | string;
}

export interface IMessageContextPayload {
	message: {
		id: number;
		conversation_message_id: number;
		out: number;
		peer_id: number;
		from_id: number;
		text?: string;
		date: number;
		update_time?: number;
		random_id: number;
		ref?: string;
		ref_source?: string;
		attachments: object[];
		important: boolean;
		geo?: {
			type: 'point';
			coordinates: {
				latitude: number;
				longitude: number;
			};
			place?: {
				id: number;
				title?: string;
				latitude?: number;
				longitude?: number;
				created?: number;
				icon?: string;
				country: number;
				city: string;

				type?: number;
				group_id?: number;
				group_photo?: string;
				checkins?: number;
				updated?: number;
				address?: number;
			};
		};
		payload?: string;
		reply_message?: IMessageReplyPayload;
		fwd_messages?: IMessageForwardPayload[];
		action?: {
			type: MessageContextPayloadEventType;
			member_id: number;
			text?: string;
			email?: string;
			photo?: {
				photo_50: string;
				photo_100: string;
				photo_200: string;
			};
		};
	};
	client_info: {
		button_actions: (
			'text'
			| 'vkpay'
			| 'open_app'
			| 'location'
			| 'open_link'
			| 'callback'
		)[];
		keyboard: boolean;
		inline_keyboard: boolean;
		carousel: boolean;
		lang_id: number;
	};
}

export type MessageContextOptions<S> =
	ContextFactoryOptions<IMessageContextPayload, S>;

class MessageContext<S = ContextDefaultState>
	extends Context<
	IMessageContextPayload,
	S,
	MessageContextType,
	MessageContextSubType
	> {
	public $match!: RegExpMatchArray;

	public text?: string;

	protected $filled: boolean;

	protected [kForwards]: MessageForwardsCollection;

	protected [kReplyMessage]: MessageReply | undefined;

	protected [kAttachments]: (Attachment | ExternalAttachment)[];

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected [kMessagePayload]: any | undefined;

	public constructor(options: MessageContextOptions<S>) {
		super({
			...options,

			type: 'message',
			subTypes: []
		});

		if (options.source === UpdateSource.POLLING) {
			this.$filled = false;

			this.applyPayload(
				transformMessage((options.payload as unknown) as Parameters<typeof transformMessage>[0])
			);
		} else {
			this.$filled = true;

			this.applyPayload(options.payload);
		}

		this.subTypes = [
			this.eventType
			|| subTypesEnum[options.updateType]
			|| options.updateType as MessageContextSubType
		];
	}

	/**
	 * Load message payload
	 */
	async loadMessagePayload({ force = false } = {}): Promise<void> {
		if (this.$filled && !force) {
			return;
		}

		const { items } = this.id !== 0
			? await this.api.messages.getById({
				message_ids: this.id
			})
			: await this.api.messages.getByConversationMessageId({
				peer_id: this.peerId,
				conversation_message_ids: this.conversationMessageId!
			});

		const [message] = items;

		this.applyPayload(message as IMessageContextPayload['message']);

		this.$filled = true;
	}

	/**
	 * Checks if there is text
	 */
	public get hasText(): boolean {
		return Boolean(this.text);
	}

	/**
	 * Checks for reply message
	 */
	public get hasReplyMessage(): boolean {
		return this.replyMessage !== undefined;
	}

	/**
	 * Checks for forwarded messages
	 */
	public get hasForwards(): boolean {
		return this.forwards.length > 0;
	}

	/**
	 * Checks for hast message payload
	 */
	public get hasMessagePayload(): boolean {
		return Boolean(this.message.payload);
	}

	/**
	 * Checks if there is text
	 */
	public get hasGeo(): boolean {
		return Boolean(this.message.geo);
	}

	/**
	 * Checks is a chat
	 */
	public get isChat(): boolean {
		return this.peerType === MessageSource.CHAT;
	}

	/**
	 * Check is a user
	 */
	public get isUser(): boolean {
		return this.senderType === MessageSource.USER;
	}

	/**
	 * Checks is a group
	 */
	public get isGroup(): boolean {
		return this.senderType === MessageSource.GROUP;
	}

	/**
	 * Checks is from the user
	 */
	public get isFromUser(): boolean {
		return this.peerType === MessageSource.USER;
	}

	/**
	 * Checks is from the group
	 */
	public get isFromGroup(): boolean {
		return this.peerType === MessageSource.GROUP;
	}

	/**
	 * Checks a message has arrived in direct messages
	 */
	public get isDM(): boolean {
		return this.isFromUser || this.isFromGroup;
	}

	/**
	 * Check is special event
	 */
	public get isEvent(): boolean {
		return this.eventType !== undefined;
	}

	/**
	 * Checks whether the message is outbox
	 */
	public get isOutbox(): boolean {
		return Boolean(this.message.out);
	}

	/**
	 * Checks whether the message is inbox
	 */
	public get isInbox(): boolean {
		return !this.isOutbox;
	}

	/**
	 * Checks that the message is important
	 */
	public get isImportant(): boolean {
		return this.message.important;
	}

	/**
	 * Returns the identifier message
	 */
	public get id(): number {
		return this.message.id;
	}

	/**
	 * Returns the conversation message id
	 */
	public get conversationMessageId(): number | undefined {
		return this.message.conversation_message_id;
	}

	/**
	 * Returns the destination identifier
	 */
	public get peerId(): number {
		return this.message.peer_id;
	}

	/**
	 * Returns the peer type
	 */
	public get peerType(): string {
		return getPeerType(this.message.peer_id);
	}

	/**
	 * Returns the sender identifier
	 */
	public get senderId(): number {
		return this.message.from_id;
	}

	/**
	 * Returns the sender type
	 */
	public get senderType(): string {
		return getPeerType(this.message.from_id);
	}

	/**
	 * Returns the identifier chat
	 */
	public get chatId(): number | undefined {
		if (!this.isChat) {
			return undefined;
		}

		return this.peerId - CHAT_PEER;
	}

	/**
	 * Returns the referral value
	 */
	public get referralValue(): string | undefined {
		return this.message.ref;
	}

	/**
	 * Returns the referral source
	 */
	public get referralSource(): string | undefined {
		return this.message.ref_source;
	}

	/**
	 * Returns the date when this message was created
	 */
	public get createdAt(): number {
		return this.message.date;
	}

	/**
	 * Returns the date when this message was updated
	 */
	public get updatedAt(): number | undefined {
		return this.message.update_time;
	}

	/**
	 * Returns geo
	 */
	public get geo(): IMessageContextPayload['message']['geo'] | undefined {
		if (!this.hasGeo) {
			return undefined;
		}

		if (!this.$filled) {
			throw new VKError({
				message: 'The message payload is not fully loaded',
				code: 'PAYLOAD_IS_NOT_FULL'
			});
		}

		return this.message.geo;
	}

	/**
	 * Returns the event name
	 */
	public get eventType(): MessageContextPayloadEventType | undefined {
		return this.message.action?.type;
	}

	/**
	 * Returns the event member id
	 */
	public get eventMemberId(): number | undefined {
		return this.message.action?.member_id;
	}

	/**
	 * Returns the event name
	 */
	public get eventText(): string | undefined {
		return this.message.action?.text;
	}

	/**
	 * Returns the event email
	 */
	public get eventEmail(): string | undefined {
		return this.message.action?.email;
	}

	/**
	 * Returns the message payload
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public get messagePayload(): any | undefined {
		return this[kMessagePayload];
	}

	/**
	 * Returns the forwards
	 */
	public get forwards(): MessageForwardsCollection {
		return this[kForwards];
	}

	/**
	 * Returns the reply message
	 */
	public get replyMessage(): MessageReply | undefined {
		return this[kReplyMessage];
	}

	/**
	 * Returns the attachments
	 */
	public get attachments(): (Attachment | ExternalAttachment)[] {
		return this[kAttachments];
	}

	/**
	 * Returns the capabilities of the client the user is using.
	 */
	public get clientInfo(): IMessageContextPayload['client_info'] {
		return this.payload.client_info;
	}

	/**
	 * Edits a message
	 */
	editMessage(params: IMessageContextSendOptions): Promise<number> {
		const target = this.id !== 0
			? { id: this.id }
			: { conversation_message_id: this.conversationMessageId };

		return this.api.messages.edit({
			...target,

			attachment: String(
				this.attachments.filter(attachment => (
					attachment.canBeAttached
				))
			),
			message: this.text!,
			keep_forward_messages: 1,
			keep_snippets: 1,

			...params,

			peer_id: this.peerId,
			message_id: this.id
		} as Params.MessagesEditParams);
	}

	/**
	 * Edits a message text
	 */
	async editMessageText(message: string): Promise<number> {
		const response = await this.editMessage({ message });

		this.text = message;

		return response;
	}

	/**
	 * Sends a message to the current dialog
	 */
	async send(
		text: string | IMessageContextSendOptions,
		params?: IMessageContextSendOptions
	): Promise<MessageContext> {
		const randomId = getRandomId();

		const options = {
			peer_id: this.peerId,
			random_id: randomId,

			...(
				typeof text !== 'object'
					? {
						message: text,

						...params
					}
					: text
			)
		} as IMessageContextSendOptions;

		const id = await this.api.messages.send(options);

		const { message } = this;

		const messageContext = new MessageContext({
			api: this.api,
			upload: this.upload,
			source: UpdateSource.WEBHOOK,
			groupId: this.$groupId,
			updateType: 'message_new',
			state: this.state,
			payload: {
				client_info: this.clientInfo,
				message: {
					id,
					conversation_message_id: 0,

					// TODO: This must be the bot identifier
					from_id: message.from_id,
					peer_id: message.peer_id,

					out: 1,
					important: false,
					random_id: randomId,

					text: options.text,

					date: Math.floor(Date.now() / 1000),

					attachments: []
				}
			}
		});

		messageContext.$filled = false;

		return messageContext;
	}

	/**
	 * Responds to the current message
	 */
	reply(
		text: string | IMessageContextSendOptions,
		params?: IMessageContextSendOptions
	): Promise<MessageContext> {
		return this.send({
			reply_to: this.id,

			...(
				typeof text !== 'object'
					? {
						message: text,

						...params
					}
					: text
			)
		});
	}

	/**
	 * Sends a sticker to the current dialog
	 */
	sendSticker(id: number): Promise<MessageContext> {
		return this.send({
			sticker_id: id
		});
	}

	/**
	 * Sends a photos to the current dialog
	 */
	async sendPhotos(
		rawSources: AllowArray<IUploadSourceMedia>,
		params: IMessageContextSendOptions = {}
	): Promise<MessageContext> {
		const sources = !Array.isArray(rawSources)
			? [rawSources]
			: rawSources;

		const attachment = await Promise.all(sources.map(source => (
			this.upload.messagePhoto({
				source,

				peer_id: this.peerId
			})
		)));

		return this.send({
			...params,

			attachment
		});
	}

	/**
	 * Sends a documents to the current dialog
	 */
	async sendDocuments(
		rawSources: AllowArray<IUploadSourceMedia>,
		params: IMessageContextSendOptions = {}
	): Promise<MessageContext> {
		const sources = !Array.isArray(rawSources)
			? [rawSources]
			: rawSources;

		const attachment = await Promise.all(sources.map(source => (
			this.upload.messageDocument({
				source,

				peer_id: this.peerId
			})
		)));

		return this.send({
			...params,

			attachment
		});
	}

	/**
	 * Sends a audio message to the current dialog
	 */
	async sendAudioMessage(
		source: IUploadSourceMedia,
		params: IMessageContextSendOptions = {}
	): Promise<MessageContext> {
		const attachment = await this.upload.audioMessage({
			source,

			peer_id: this.peerId
		});

		return this.send({
			...params,

			attachment
		});
	}

	/**
	 * Changes the status of typing in the dialog
	 */
	async setActivity(): Promise<boolean> {
		const isActivited = await this.api.messages.setActivity({
			peer_id: this.peerId,
			type: 'typing'
		});

		return Boolean(isActivited);
	}

	/**
	 * Marks messages as important or removes a mark
	 */
	async markAsImportant(
		ids = [this.id],
		options = { important: Number(!this.isImportant) }
	): Promise<number[]> {
		const messageIds = await this.api.messages.markAsImportant({
			...options,

			message_ids: ids
		});

		if (messageIds.includes(this.id)) {
			this.message.important = Boolean(options.important);
		}

		return messageIds;
	}

	/**
	 * Deletes the message
	 */
	async deleteMessage(ids: number[] = [this.id], options = { spam: 0 }): Promise<number> {
		const messageIds = await this.api.messages.delete({
			...options,

			message_ids: ids
		});

		return messageIds;
	}

	/**
	 * Restores the message
	 */
	async restoreMessage(): Promise<boolean> {
		const isRestored = await this.api.messages.restore({
			message_id: this.id
		});

		return Boolean(isRestored);
	}

	/**
	 * Rename the chat
	 */
	public async renameChat(title: string): Promise<boolean> {
		this.assertIsChat();

		const isRenamed = await this.api.messages.editChat({
			chat_id: this.chatId!,
			title
		});

		return Boolean(isRenamed);
	}

	/**
	 * Sets a new image for the chat
	 */
	public async newChatPhoto(source: IUploadSourceMedia, params: object = {}): Promise<object> {
		this.assertIsChat();

		const response = await this.upload.chatPhoto({
			...params,

			chat_id: this.chatId!,
			source
		});

		return response;
	}

	/**
	 * Remove the chat photo
	 */
	public async deleteChatPhoto(): Promise<boolean> {
		this.assertIsChat();

		await this.api.messages.deleteChatPhoto({
			chat_id: this.chatId!
		});

		return true;
	}

	/**
	 * Invites a new user
	 */
	public async inviteUser(id: number = this.eventMemberId!): Promise<boolean> {
		this.assertIsChat();

		const isInvited = await this.api.messages.addChatUser({
			chat_id: this.chatId!,
			user_id: id
		});

		return Boolean(isInvited);
	}

	/**
	 * Excludes user
	 */
	public async kickUser(id: number = this.eventMemberId!): Promise<boolean> {
		this.assertIsChat();

		const isKicked = await this.api.messages.removeChatUser({
			chat_id: this.chatId!,
			member_id: id
		});

		return Boolean(isKicked);
	}

	/**
	 * Pins a message
	 */
	public async pinMessage(): Promise<boolean> {
		this.assertIsChat();

		const isPinned = await this.api.messages.pin({
			peer_id: this.peerId,
			message_id: this.id
		});

		return Boolean(isPinned);
	}

	/**
	 * Unpins a message
	 */
	public async unpinMessage(): Promise<boolean> {
		this.assertIsChat();

		const isUnpinned = await this.api.messages.unpin({
			peer_id: this.peerId,
			message_id: this.id
		});

		return Boolean(isUnpinned);
	}

	/**
	 * Return alias of payload.message
	 */
	protected get message(): IMessageContextPayload['message'] {
		return this.payload.message;
	}

	/**
	 * Applies the payload
	 */
	private applyPayload(
		payload: IMessageContextPayload
		| IMessageContextPayload['message']
	): void {
		// Polyfill for all events except new_message
		if (!('client_info' in payload)) {
			// eslint-disable-next-line no-param-reassign
			payload = {
				message: payload as IMessageContextPayload['message'],
				client_info: {
					button_actions: [
						'text'
					],
					inline_keyboard: false,
					keyboard: true,
					carousel: false,
					lang_id: 0
				}
			};
		}

		this.payload = payload;

		const { text } = payload.message;

		this.text = text
			? unescapeHTML(text)
			: undefined;

		const { message } = this;

		this[kAttachments] = transformAttachments(message.attachments, this.api);

		if (message.reply_message) {
			this[kReplyMessage] = new MessageReply({
				api: this.api,
				payload: message.reply_message
			});
		}

		this[kForwards] = new MessageForwardsCollection(...(message.fwd_messages || []).map(forward => (
			new MessageForward({
				api: this.api,
				payload: forward
			})
		)));

		if (message.payload) {
			this[kMessagePayload] = JSON.parse(message.payload);
		}
	}

	/**
	 * Checks that in a chat
	 */
	private assertIsChat(): void {
		if (!this.isChat) {
			throw new VKError({
				message: 'This method is only available in chat',
				code: 'IS_NOT_CHAT'
			});
		}
	}

	/**
	 * Returns the custom data
	 */
	public [kSerializeData](): object {
		const beforeAttachments: string[] = [];

		if (this.isEvent) {
			beforeAttachments.push(
				'eventType',
				'eventMemberId',
				'eventText',
				'eventEmail'
			);
		}

		if (this.hasReplyMessage) {
			beforeAttachments.push('replyMessage');
		}

		const afterAttachments: string[] = [];

		if (this.hasMessagePayload) {
			afterAttachments.push('messagePayload');
		}

		afterAttachments.push('isOutbox');

		if (this.referralValue) {
			afterAttachments.push('referralValue', 'referralSource');
		}

		if (this.$match) {
			afterAttachments.push('$match');
		}

		return pickProperties(this, [
			'id',
			'conversationMessageId',
			'peerId',
			'peerType',
			'senderId',
			'senderType',
			'createdAt',
			'updatedAt',
			'text',
			...beforeAttachments,
			'forwards',
			'attachments',
			...afterAttachments
		]);
	}
}

// eslint-disable-next-line
interface MessageContext extends Attachmentable, IAllAttachmentable {}
applyMixins(MessageContext, [
	Attachmentable,
	class AllAttachmentable extends Attachmentable {
		public replyMessage?: MessageReply;

		public forwards!: MessageForwardsCollection;

		public hasAllAttachments(type: AttachmentType | AttachmentTypeString | undefined): boolean {
			return (
				this.hasAttachments(type)
				|| (this.replyMessage?.hasAttachments(type))
				|| this.forwards.hasAttachments(type)
			);
		}

		public getAllAttachments(
			type: AttachmentType | AttachmentTypeString
		): (Attachment | ExternalAttachment)[] {
			return [
				// @ts-expect-error
				...this.getAttachments(type),
				// @ts-expect-error
				...((this.replyMessage?.getAttachments(type)) ?? []),
				// @ts-expect-error
				...this.forwards.getAttachments(type)
			];
		}
	}
]);

export { MessageContext };
