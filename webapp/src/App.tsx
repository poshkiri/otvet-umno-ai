import {
  ArrowLeftIcon,
  CameraIcon,
  CheckCircledIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  FileTextIcon,
  Link2Icon,
  PaperPlaneIcon,
  PlayIcon,
  ReloadIcon,
  SpeakerLoudIcon,
} from "@radix-ui/react-icons";
import { AnimatePresence, motion } from "motion/react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, miniAppApi, type AccessPayload, type SessionPayload } from "./api";
import { telegramWebApp } from "./telegram";

type View = "home" | "working" | "result" | "limit" | "error";

interface ResultSection {
  title: string;
  body: string;
}

type HistoryItem = SessionPayload["history"][number];

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

const DEMO_RESULT = [
  "Что на фото",
  "Это упаковка гречки. На лицевой стороне указаны вес, способ приготовления и основные свойства продукта.",
  "",
  "Что важно",
  "Проверь срок годности, целостность упаковки и состав на обратной стороне. Если пришлёшь её фотографию, я разберу всё подробнее.",
  "",
  "Как использовать",
  "Промой крупу, залей водой в пропорции примерно 1 к 2 и вари на слабом огне до готовности.",
].join("\n");

const DEMO_TEXT_RESULT = [
  "Короткий ответ",
  "Инфляция — это общий рост цен, из-за которого со временем на одну и ту же сумму можно купить меньше товаров и услуг.",
  "",
  "Простой пример",
  "Если год назад продукт стоил 100 рублей, а сейчас 110, его цена выросла на 10%. На инфляцию смотрят по изменению цен сразу на большую корзину товаров.",
].join("\n");

const DEMO_HISTORY: HistoryItem[] = [
  {
    id: -1,
    source: "Решите неравенство",
    result: "Решим неравенство по шагам и проверим область допустимых значений.",
    flow: "analyze",
    createdAt: new Date().toISOString(),
  },
  {
    id: -2,
    source: "Что такое инфляция?",
    result: "Объяснение инфляции простыми словами с понятным примером.",
    flow: "analyze",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

export default function App() {
  const telegram = useMemo(() => telegramWebApp(), []);
  const isDemo = !telegram?.initData;
  const isMobilePreview = new URLSearchParams(window.location.search).has("mobile-preview");
  const [view, setView] = useState<View>("home");
  const [previewUrl, setPreviewUrl] = useState("/app/product-grocery.jpg");
  const [resultPreview, setResultPreview] = useState("");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [access, setAccess] = useState<AccessPayload>({ remaining: 5, label: "5 запросов", plan: "free" });
  const [history, setHistory] = useState<HistoryItem[]>(isDemo ? DEMO_HISTORY : []);
  const [botUsername, setBotUsername] = useState("OtvetUmnoAI_bot");
  const [result, setResult] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [followUps, setFollowUps] = useState<Array<{ question: string; answer: string }>>([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [workingText, setWorkingText] = useState("Готовлю понятный ответ");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const recognition = useRef<SpeechRecognitionLike | undefined>(undefined);

  const applySession = (session: SessionPayload) => {
    setAccess(session.access);
    setBotUsername(session.botUsername);
    setHistory(session.history);
  };

  const showError = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : "Что-то пошло не так";
    setError(message);
    setView(reason instanceof ApiError && reason.code === "LIMIT_REACHED" ? "limit" : "error");
    telegram?.HapticFeedback?.notificationOccurred("error");
  };

  useEffect(() => {
    telegram?.ready();
    telegram?.expand();
    telegram?.setHeaderColor?.("#f7f8f7");
    telegram?.setBackgroundColor?.("#f7f8f7");
    if (!telegram?.initData) return;
    miniAppApi.session(telegram.initData).then(applySession).catch((reason: unknown) => showError(reason));
  }, [telegram]);

  useEffect(() => () => {
    recognition.current?.stop();
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const refreshSession = async () => {
    if (!telegram?.initData) return;
    applySession(await miniAppApi.session(telegram.initData));
  };

  const chooseFile = (file?: File) => {
    if (!file) return;
    if (!file.type.match(/^image\/(jpeg|png|webp)$/)) {
      showError(new Error("Выбери фотографию JPG, PNG или WebP."));
      return;
    }
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    telegram?.HapticFeedback?.impactOccurred("light");
  };

  const analyze = async () => {
    if (!selectedFile && !isDemo) {
      fileInput.current?.click();
      return;
    }
    setWorkingText("Разбираю фотографию");
    setView("working");
    telegram?.HapticFeedback?.impactOccurred("medium");
    try {
      if (isDemo) {
        await wait(1_100);
        setResult(DEMO_RESULT);
        setConversationId("demo");
        setAccess({ ...access, remaining: Math.max(0, (access.remaining ?? 5) - 1), label: "4 запроса" });
      } else {
        const response = await miniAppApi.analyze(telegram!.initData, selectedFile!, question.trim() || undefined);
        setResult(response.result);
        setConversationId(response.conversationId);
        setAccess(response.access);
        await refreshSession();
      }
      setResultPreview(previewUrl);
      setFollowUps([]);
      setQuestion("");
      setView("result");
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch (reason) {
      showError(reason);
    }
  };

  const askGeneral = async (text: string) => {
    setWorkingText("Готовлю понятный ответ");
    setView("working");
    setSending(true);
    try {
      if (isDemo) {
        await wait(900);
        setResult(DEMO_TEXT_RESULT);
        setAccess({ ...access, remaining: Math.max(0, (access.remaining ?? 5) - 1), label: "4 запроса" });
      } else {
        const response = await miniAppApi.ask(telegram!.initData, text);
        setResult(response.result);
        setAccess(response.access);
        await refreshSession();
      }
      setResultPreview("");
      setConversationId("");
      setFollowUps([]);
      setQuestion("");
      setView("result");
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch (reason) {
      showError(reason);
    } finally {
      setSending(false);
    }
  };

  const submitHome = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (selectedFile) {
      await analyze();
      return;
    }
    if (text) await askGeneral(text);
  };

  const startVoiceInput = () => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      showError(new Error("Голосовой ввод недоступен на этом устройстве. Можно отправить голосовое сообщение прямо в боте."));
      return;
    }
    recognition.current?.stop();
    const next = new Recognition();
    next.lang = "ru-RU";
    next.continuous = false;
    next.interimResults = false;
    next.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) setQuestion(transcript);
      telegram?.HapticFeedback?.notificationOccurred("success");
    };
    next.onerror = () => setError("Не удалось распознать голос. Попробуй ещё раз или напиши вопрос.");
    next.onend = () => setListening(false);
    recognition.current = next;
    setListening(true);
    next.start();
    telegram?.HapticFeedback?.impactOccurred("light");
  };

  const askFollowUp = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setQuestion("");
    try {
      const response = isDemo
        ? { result: "Разберём это по шагам. Сначала выделим главное, затем проверим детали.", access }
        : conversationId
          ? await miniAppApi.followUp(telegram!.initData, conversationId, trimmed)
          : await miniAppApi.ask(telegram!.initData, trimmed);
      setFollowUps((items) => [...items, { question: trimmed, answer: response.result }]);
      setAccess(response.access);
      if (!isDemo) await refreshSession();
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch (reason) {
      showError(reason);
    } finally {
      setSending(false);
    }
  };

  const openHistoryItem = (item: HistoryItem) => {
    setResult(item.result);
    setResultPreview(item.id === -1 ? "/app/math-problem.jpg" : "");
    setConversationId("");
    setFollowUps([]);
    setView("result");
  };

  const openPlans = () => telegram?.openTelegramLink(`https://t.me/${botUsername}?start=miniapp_plus`);

  const resetHome = () => {
    setView("home");
    setError("");
    setResult("");
    setResultPreview("");
    setConversationId("");
    setFollowUps([]);
  };

  return (
    <div className={`app ${isMobilePreview ? "mobile-preview" : ""}`}>
      <AnimatePresence mode="wait">
        {view === "home" && (
          <HomeView
            access={access}
            history={history}
            previewUrl={previewUrl}
            selectedFile={selectedFile}
            question={question}
            listening={listening}
            onQuestion={setQuestion}
            onChoosePhoto={() => fileInput.current?.click()}
            onAnalyze={analyze}
            onSubmit={submitHome}
            onVoice={startVoiceInput}
            onOpenHistory={openHistoryItem}
          />
        )}
        {view === "working" && <WorkingView previewUrl={selectedFile ? previewUrl : ""} text={workingText} />}
        {view === "result" && (
          <ResultView
            access={access}
            previewUrl={resultPreview}
            result={result}
            followUps={followUps}
            question={question}
            sending={sending}
            onQuestion={setQuestion}
            onSubmit={askFollowUp}
            onBack={resetHome}
          />
        )}
        {view === "limit" && <MessageView title="Запросы закончились" text={error} action="Посмотреть Plus" onAction={openPlans} onBack={resetHome} />}
        {view === "error" && <MessageView title="Не получилось" text={error} action="Вернуться" onAction={resetHome} onBack={resetHome} />}
      </AnimatePresence>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        onChange={(event) => chooseFile(event.target.files?.[0])}
      />
    </div>
  );
}

function HomeView({ access, history, previewUrl, selectedFile, question, listening, onQuestion, onChoosePhoto, onAnalyze, onSubmit, onVoice, onOpenHistory }: {
  access: AccessPayload;
  history: HistoryItem[];
  previewUrl: string;
  selectedFile?: File;
  question: string;
  listening: boolean;
  onQuestion: (value: string) => void;
  onChoosePhoto: () => void;
  onAnalyze: () => void;
  onSubmit: (event: FormEvent) => void;
  onVoice: () => void;
  onOpenHistory: (item: HistoryItem) => void;
}) {
  const visibleHistory = history.slice(0, 2);
  return (
    <motion.main className="home-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="topbar">
        <Brand />
        <span className="access">{access.remaining === null ? "Безлимит" : access.label}<i /></span>
      </header>

      <section className="home-content">
        <h1>Покажите или спросите</h1>
        <div className="photo-action">
          <img src={previewUrl} alt={selectedFile ? "Выбранная фотография" : "Пример фотографии товара"} />
          <button type="button" onClick={selectedFile ? onAnalyze : onChoosePhoto}>
            <CameraIcon />
            Разобрать фото
          </button>
        </div>

        <form className="home-composer" onSubmit={onSubmit}>
          <button className="attach-button" type="button" onClick={onChoosePhoto} aria-label="Прикрепить фотографию"><Link2Icon /></button>
          <input value={question} onChange={(event) => onQuestion(event.target.value)} placeholder={selectedFile ? "Что хотите узнать о фото?" : "Напишите вопрос"} aria-label="Ваш вопрос" />
          <button className={`voice-button ${listening ? "is-listening" : ""}`} type="button" onClick={onVoice} aria-label="Задать вопрос голосом"><SpeakerLoudIcon /></button>
          <button className="send-button" type="submit" disabled={!question.trim() && !selectedFile} aria-label="Отправить"><PaperPlaneIcon /></button>
        </form>
        <p className="example">Например: что это, как использовать, реши задачу</p>

        <section className="history-section">
          <div className="section-heading">
            <h2>Недавнее</h2>
            <span>Все <ChevronRightIcon /></span>
          </div>
          <div className="history-list">
            {visibleHistory.length ? visibleHistory.map((item, index) => (
              <button type="button" className="history-row" key={item.id} onClick={() => onOpenHistory(item)}>
                <span className={`history-visual ${index === 1 ? "voice" : "photo"}`}>
                  {index === 0 ? <img src="/app/math-problem.jpg" alt="Фотография учебной задачи" /> : <><PlayIcon /><SpeakerLoudIcon /></>}
                </span>
                <span className="history-copy">
                  <strong>{index === 0 ? "Скриншот задачи" : "Голосовой вопрос"}</strong>
                  <span>{index === 0 ? "Решите неравенство" : item.source}</span>
                  <time>{formatHistoryDate(item.createdAt)}</time>
                </span>
                <ChevronRightIcon />
              </button>
            )) : <p className="empty-history">Здесь появятся ваши последние вопросы и разборы.</p>}
          </div>
        </section>
      </section>
    </motion.main>
  );
}

function WorkingView({ previewUrl, text }: { previewUrl: string; text: string }) {
  return (
    <motion.main className="working-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <Brand />
      {previewUrl && <img src={previewUrl} alt="Обрабатываемая фотография" />}
      <ReloadIcon className="spin" />
      <h1>{text}</h1>
      <p>Обычно это занимает несколько секунд</p>
    </motion.main>
  );
}

function ResultView({ access, previewUrl, result, followUps, question, sending, onQuestion, onSubmit, onBack }: {
  access: AccessPayload;
  previewUrl: string;
  result: string;
  followUps: Array<{ question: string; answer: string }>;
  question: string;
  sending: boolean;
  onQuestion: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onBack: () => void;
}) {
  const sections = parseResult(result);
  const headline = sections[0]?.title || "Понятный ответ";
  return (
    <motion.main className="result-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="result-topbar">
        <button type="button" onClick={onBack} aria-label="Назад"><ArrowLeftIcon /></button>
        <Brand compact />
        <span className="result-access">{access.remaining === null ? "∞" : access.remaining}</span>
      </header>
      <div className="result-scroll">
        {previewUrl && <div className="result-photo"><img src={previewUrl} alt="Распознанный предмет" /></div>}
        <section className="summary">
          <span>Ответ Пойми AI</span>
          <h1>{headline}</h1>
          <p><CheckCircledIcon /> Готово</p>
        </section>
        {sections.map((section, index) => (
          <section className="result-section" key={`${section.title}-${index}`}>
            <div>{section.title.toLowerCase().includes("важ") ? <ExclamationTriangleIcon /> : <FileTextIcon />}</div>
            <article><h2>{section.title}</h2><p>{section.body}</p></article>
          </section>
        ))}
        {followUps.map((item, index) => (
          <section className="follow-up-answer" key={`${item.question}-${index}`}><small>Ваш вопрос</small><h2>{item.question}</h2><p>{item.answer}</p></section>
        ))}
        <div className="scroll-space" />
      </div>
      <form className="result-composer" onSubmit={onSubmit}>
        <Link2Icon />
        <input value={question} onChange={(event) => onQuestion(event.target.value)} placeholder="Задать вопрос" aria-label="Уточняющий вопрос" />
        <button type="submit" disabled={!question.trim() || sending} aria-label="Отправить вопрос">{sending ? <ReloadIcon className="spin" /> : <PaperPlaneIcon />}</button>
      </form>
    </motion.main>
  );
}

function MessageView({ title, text, action, onAction, onBack }: { title: string; text: string; action: string; onAction: () => void; onBack: () => void }) {
  return (
    <motion.main className="message-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <Brand />
      <div><ExclamationTriangleIcon /><h1>{title}</h1><p>{text}</p><button type="button" onClick={onAction}>{action}</button><button className="secondary" type="button" onClick={onBack}>На главный экран</button></div>
    </motion.main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "compact" : ""}`}><img src="/app/poymi-logo.png" alt="" /><span>Пойми AI</span></div>;
}

function parseResult(result: string): ResultSection[] {
  const sections: ResultSection[] = [];
  let current: ResultSection | undefined;
  for (const rawLine of result.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const looksLikeHeading = line.length <= 48 && !/[.!?]$/.test(line);
    if (looksLikeHeading && (!current || current.body)) {
      if (current?.body) sections.push(current);
      current = { title: line.replace(/^\S+\s*/, (value) => /[А-ЯA-Z]/.test(value) ? value : ""), body: "" };
    } else if (current) {
      current.body += `${current.body ? "\n" : ""}${line}`;
    } else {
      current = { title: "Понятный ответ", body: line };
    }
  }
  if (current?.body) sections.push(current);
  return sections.length ? sections : [{ title: "Понятный ответ", body: result }];
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Недавно";
  const isToday = date.toDateString() === new Date().toDateString();
  return `${isToday ? "Сегодня" : "Вчера"}, ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
