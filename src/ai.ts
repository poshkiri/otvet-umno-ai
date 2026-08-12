import OpenAI, { toFile } from "openai";
import {
  buildGenerationPrompt,
  buildRefinementPrompt,
  GENERAL_ASSISTANT_PROMPT,
  SYSTEM_PROMPT,
  VISION_FOLLOW_UP_PROMPT,
  VISION_SYSTEM_PROMPT,
} from "./prompts.js";
import type { CategoryId, FlowId, RefinementId } from "./types.js";
import { Semaphore } from "./semaphore.js";

export interface VisualInput {
  data: Uint8Array;
  mimeType: string;
}

export interface VisualResponse {
  text: string;
  responseId: string;
}

export class AiService {
  private readonly client: OpenAI;
  private readonly limiter = new Semaphore(4);
  private readonly imageLimiter = new Semaphore(2);

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly transcribeModel: string,
    private readonly imageModel: string,
  ) {
    this.client = new OpenAI({ apiKey, timeout: 45_000, maxRetries: 1 });
  }

  async generate(flow: FlowId, category: CategoryId, source: string): Promise<string> {
    return this.limiter.run(async () => {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: SYSTEM_PROMPT,
        input: buildGenerationPrompt(flow, category, source),
      });
      return this.requireText(response.output_text);
    });
  }

  async generateFromImage(
    image: Uint8Array,
    mimeType: string,
    caption?: string,
  ): Promise<VisualResponse> {
    return this.generateFromImages([{ data: image, mimeType }], caption);
  }

  async generateFromImages(images: VisualInput[], caption?: string): Promise<VisualResponse> {
    if (images.length === 0) throw new Error("Не передано ни одного изображения");
    const prompt = caption?.trim()
      ? `Пользователь добавил вопрос: «${caption.trim()}». Проанализируй все изображения с учётом этого вопроса.`
      : images.length > 1
        ? "Изображения отправлены одним альбомом. Определи, показывают ли они один предмет с разных сторон или разные предметы для сравнения, затем дай единый полезный разбор."
        : "Самостоятельно определи, что изображено, и дай наиболее полезное описание и объяснение.";
    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "auto" }
    > = [{ type: "input_text", text: prompt }];
    for (const image of images) {
      content.push({
        type: "input_image",
        image_url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
        detail: "auto",
      });
    }
    return this.limiter.run(async () => {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: VISION_SYSTEM_PROMPT,
        input: [{
          role: "user",
          content,
        }],
      });
      return { text: this.requireText(response.output_text), responseId: response.id };
    });
  }

  async continueVisual(previousResponseId: string, question: string): Promise<VisualResponse> {
    return this.limiter.run(async () => {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: VISION_FOLLOW_UP_PROMPT,
        previous_response_id: previousResponseId,
        input: question.trim(),
      });
      return { text: this.requireText(response.output_text), responseId: response.id };
    });
  }

  async transcribe(audio: Uint8Array, filename: string): Promise<string> {
    return this.limiter.run(async () => {
      const file = await toFile(audio, filename, { type: "audio/ogg" });
      const transcription = await this.client.audio.transcriptions.create({
        file,
        model: this.transcribeModel,
        language: "ru",
      });
      return transcription.text.trim();
    });
  }

  async answerGeneral(question: string): Promise<string> {
    return this.limiter.run(async () => {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: GENERAL_ASSISTANT_PROMPT,
        input: question.trim(),
      });
      return this.requireText(response.output_text);
    });
  }

  async generateImage(prompt: string, telegramId: number): Promise<Uint8Array> {
    return this.imageLimiter.run(async () => {
      const response = await this.client.images.generate({
        model: this.imageModel,
        prompt: prompt.trim(),
        size: "1024x1024",
        quality: "medium",
        output_format: "png",
        n: 1,
        user: String(telegramId),
      }, { timeout: 120_000, maxRetries: 1 });
      const encoded = response.data?.[0]?.b64_json;
      if (!encoded) throw new Error("AI не вернул изображение");
      return Buffer.from(encoded, "base64");
    });
  }

  async refine(refinement: RefinementId, source: string, previousResult: string): Promise<string> {
    return this.limiter.run(async () => {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: SYSTEM_PROMPT,
        input: buildRefinementPrompt(refinement, source, previousResult),
      });
      return this.requireText(response.output_text);
    });
  }

  private requireText(text: string): string {
    const result = text.trim();
    if (!result) throw new Error("AI вернул пустой ответ");
    return result;
  }
}
