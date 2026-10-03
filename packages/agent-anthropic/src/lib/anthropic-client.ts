/** Injected transport subset of Anthropic's non-streaming Messages API. */
export interface AnthropicTextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface AnthropicConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AnthropicMessageRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: ReadonlyArray<AnthropicConversationMessage>;
  readonly system?: ReadonlyArray<AnthropicTextBlock>;
  readonly output_config: {
    readonly format: {
      readonly type: 'json_schema';
      readonly schema: Record<string, unknown>;
    };
  };
}

export interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface AnthropicUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

export interface AnthropicMessage {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly model: string;
  readonly content: ReadonlyArray<AnthropicContentBlock>;
  readonly stop_reason: string | null;
  readonly usage: AnthropicUsage;
}

export interface AnthropicRequestOptions {
  readonly signal?: AbortSignal;
}

export interface AnthropicClient {
  readonly messages: {
    create(
      request: AnthropicMessageRequest,
      options?: AnthropicRequestOptions,
    ): Promise<AnthropicMessage>;
  };
}
