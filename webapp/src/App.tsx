import {
  ArrowLeftIcon,
  CameraIcon,
  CheckCircledIcon,
  ChevronRightIcon,
  ChatBubbleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  FileTextIcon,
  Link2Icon,
  HomeIcon,
  LockClosedIcon,
  PaperPlaneIcon,
  PersonIcon,
  QuestionMarkCircledIcon,
  ReaderIcon,
  ReloadIcon,
  SpeakerLoudIcon,
  StarIcon,
} from "@radix-ui/react-icons";
import { AnimatePresence, motion } from "motion/react";
import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, miniAppApi, type AccessPayload, type SessionPayload } from "./api";
import { telegramWebApp } from "./telegram";

type View = "home" | "history" | "profile" | "working" | "result" | "limit" | "error";

interface ResultSection {
  title: string;
  body: string;
}

type HistoryItem = SessionPayload["history"][number];
type InfoPageId = "privacy" | "terms" | "tariffs" | "support";

interface InfoSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
}

interface InfoPageContent {
  eyebrow: string;
  title: string;
  intro: string;
  sections: InfoSection[];
}

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

const DEMO_SESSION: SessionPayload = {
  user: { firstName: "Max" },
  access: { remaining: 5, label: "5 запросов", plan: "free" },
  botUsername: "OtvetUmnoAI_bot",
  payments: {
    plategaEnabled: true,
    packages: [
      { id: "start", title: "50 запросов", credits: 50, rubles: 199 },
      { id: "plus", title: "200 запросов", credits: 200, rubles: 649 },
      { id: "pro", title: "500 запросов", credits: 500, rubles: 1_490 },
    ],
    recent: [],
  },
  history: DEMO_HISTORY,
};

const INFO_PAGES: Record<InfoPageId, InfoPageContent> = {
  privacy: {
    eyebrow: "Документы",
    title: "Политика конфиденциальности",
    intro: "Объясняем, какие данные нужны Пойми AI и как мы с ними работаем.",
    sections: [
      {
        title: "Какие данные обрабатываются",
        bullets: [
          "Telegram ID, имя и username, если они указаны в аккаунте.",
          "Ваши вопросы, фотографии, голосовые сообщения и результаты обработки.",
          "История запросов, лимиты, идентификаторы и статусы платежей.",
          "Технические события, необходимые для безопасности и стабильной работы.",
        ],
      },
      {
        title: "Зачем это нужно",
        paragraphs: ["Данные используются, чтобы отвечать на запросы, хранить историю, учитывать лимиты, обрабатывать оплату, помогать при обращениях и улучшать сервис."],
      },
      {
        title: "Кому передаются данные",
        paragraphs: ["Только в объёме, необходимом для работы сервиса: Telegram обеспечивает интерфейс, провайдер AI обрабатывает запросы, Render размещает приложение, а Platega обрабатывает платежи. Пойми AI не хранит данные банковской карты."],
      },
      {
        title: "Хранение и удаление",
        paragraphs: ["Данные хранятся, пока это необходимо для работы аккаунта, поддержки, безопасности и учёта операций. Запросить удаление своих данных можно через поддержку. Информация о проведённых платежах может храниться дольше, если этого требуют правила учёта."],
      },
      {
        title: "Ваши права",
        paragraphs: ["Вы можете запросить сведения о своих данных, исправить их или попросить удалить. Для этого откройте страницу поддержки и укажите свой Telegram ID."],
      },
    ],
  },
  terms: {
    eyebrow: "Документы",
    title: "Пользовательское соглашение",
    intro: "Правила использования сервиса Пойми AI. Продолжая работу, пользователь принимает эти условия.",
    sections: [
      {
        title: "Что делает сервис",
        paragraphs: ["Пойми AI отвечает на текстовые и голосовые вопросы, анализирует изображения, помогает с учёбой и текстами, создаёт и изменяет изображения. Ответы формируются автоматически и могут содержать неточности."],
      },
      {
        title: "Ответственность пользователя",
        bullets: [
          "Не отправлять незаконные материалы и чужие персональные данные без разрешения.",
          "Не использовать сервис для обмана, вреда, обхода закона или нарушения чужих прав.",
          "Проверять важные медицинские, юридические, финансовые и иные решения у профильного специалиста.",
        ],
      },
      {
        title: "Платные возможности",
        paragraphs: ["Перед оплатой пользователь видит состав пакета, срок действия и окончательную цену. Запросы начисляются после подтверждения платежа. Разовые пакеты не сгорают, а условия Plus действуют 30 дней."],
      },
      {
        title: "Возвраты и спорные операции",
        paragraphs: ["Если запросы не начислились, платёж проведён ошибочно или услуга не была оказана, обратитесь в поддержку и сообщите ID платежа. Обращение рассматривается с учётом статуса операции и фактически использованного объёма услуги."],
      },
      {
        title: "Изменения и доступ",
        paragraphs: ["Функции, цены и условия могут обновляться. Актуальная версия всегда опубликована на страницах сервиса. При нарушении правил доступ к сервису может быть ограничен."],
      },
    ],
  },
  tariffs: {
    eyebrow: "Оплата",
    title: "Тарифы и цены",
    intro: "Все цены показываются до оплаты. Скрытых списаний нет.",
    sections: [
      {
        title: "Бесплатно",
        bullets: ["5 AI-запросов после первого запуска.", "1 пробное создание изображения."],
      },
      {
        title: "Plus — 399 Stars на 30 дней",
        bullets: ["100 AI-единиц.", "До 20 созданий или изменений изображений.", "Продление можно отключить в Telegram."],
      },
      {
        title: "Разовые пакеты в Telegram",
        bullets: ["50 запросов — 199 Stars.", "200 запросов — 699 Stars.", "500 запросов — 1599 Stars."],
      },
      {
        title: "Как списываются запросы",
        paragraphs: ["Обычный ответ или разбор фотографии расходует один запрос. Создание и изменение изображений учитывается по отдельному лимиту тарифа. Разовые запросы не сгорают."],
      },
      {
        title: "Для проверки проекта",
        paragraphs: ["Код согласования: Platega test. После выдачи рабочих доступов эта строка будет удалена."],
      },
    ],
  },
  support: {
    eyebrow: "Помощь",
    title: "Поддержка",
    intro: "Поддержка доступна всем пользователям, даже если подписки нет. Поможем, если запросы не начислились, платёж завис или в сервисе появилась ошибка.",
    sections: [
      {
        title: "Как обратиться",
        paragraphs: ["Напишите напрямую в Telegram: @PoymiAI_support. Поддержка доступна всем пользователям независимо от наличия подписки."],
      },
      {
        title: "Кто может написать",
        paragraphs: ["Обращение может отправить любой пользователь: бесплатный, платный или ещё не оплативший тариф."],
      },
      {
        title: "Что указать",
        bullets: ["Telegram ID или username.", "ID платежа из раздела «Мои покупки».", "Что произошло и когда.", "Скриншот ошибки, если он есть."],
      },
      {
        title: "Важно",
        paragraphs: ["Никому не отправляйте код из SMS, пароль, данные карты или секретные ключи. Для проверки платежа поддержке достаточно ID операции."],
      },
    ],
  },
};

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
  const [session, setSession] = useState<SessionPayload | undefined>(isDemo ? DEMO_SESSION : undefined);
  const [paymentBusy, setPaymentBusy] = useState("");
  const [paymentNotice, setPaymentNotice] = useState("");
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
    setSession(session);
    setAccess(session.access);
    setBotUsername(session.botUsername);
    setHistory(session.history);
  };

  const checkPendingPayment = async () => {
    if (!telegram?.initData) return;
    const transactionId = window.localStorage.getItem("poymi-pending-payment");
    if (!transactionId) return;
    setPaymentBusy(transactionId);
    try {
      const payment = await miniAppApi.plategaPayment(telegram.initData, transactionId);
      setAccess(payment.access);
      if (payment.status === "confirmed") {
        window.localStorage.removeItem("poymi-pending-payment");
        setPaymentNotice("Оплата подтверждена. Запросы уже начислены.");
        await refreshSession();
      } else if (payment.status === "canceled" || payment.status === "chargebacked") {
        window.localStorage.removeItem("poymi-pending-payment");
        setPaymentNotice("Платёж не завершён. Можно попробовать ещё раз.");
      } else {
        setPaymentNotice("Платёж ещё обрабатывается. Проверим снова через несколько секунд.");
      }
    } catch (reason) {
      setPaymentNotice(reason instanceof Error ? reason.message : "Не удалось проверить платёж");
    } finally {
      setPaymentBusy("");
    }
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
    if (new URLSearchParams(window.location.search).has("payment")) void checkPendingPayment();
  }, [telegram]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void checkPendingPayment(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
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
    await submitFollowUp(question);
  };

  const submitFollowUp = async (text: string) => {
    const trimmed = text.trim();
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

  const buyWithPlatega = async (packageId: string) => {
    if (!telegram?.initData || paymentBusy) return;
    setPaymentBusy(packageId);
    setPaymentNotice("");
    try {
      const payment = await miniAppApi.createPlategaPayment(telegram.initData, packageId);
      window.localStorage.setItem("poymi-pending-payment", payment.transactionId);
      if (telegram.openLink) telegram.openLink(payment.url);
      else window.open(payment.url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setPaymentNotice(reason instanceof Error ? reason.message : "Не удалось открыть оплату");
    } finally {
      setPaymentBusy("");
    }
  };

  const resetHome = () => {
    setView("home");
    setError("");
    setResult("");
    setResultPreview("");
    setConversationId("");
    setFollowUps([]);
  };

  const infoPageId = infoPageFromPath(window.location.pathname);
  if (infoPageId) return <InfoPage pageId={infoPageId} />;

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
            onHistory={() => setView("history")}
            onProfile={() => setView("profile")}
          />
        )}
        {view === "history" && (
          <HistoryView
            history={history}
            onOpen={openHistoryItem}
            onHome={resetHome}
            onProfile={() => setView("profile")}
          />
        )}
        {view === "profile" && session && (
          <ProfileView
            session={session}
            busy={paymentBusy}
            notice={paymentNotice}
            onHome={resetHome}
            onHistory={() => setView("history")}
            onStars={openPlans}
            onBuy={buyWithPlatega}
            onCheck={checkPendingPayment}
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
            onQuickAction={submitFollowUp}
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

function HomeView({ access, history, previewUrl, selectedFile, question, listening, onQuestion, onChoosePhoto, onAnalyze, onSubmit, onVoice, onOpenHistory, onHistory, onProfile }: {
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
  onHistory: () => void;
  onProfile: () => void;
}) {
  const latest = history[0];
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
        <p className="example">Фото, документ, задача или обычный вопрос</p>

        <section className="recent-section">
          <div className="section-heading">
            <h2>Продолжить</h2>
            <button type="button" onClick={onHistory}>Вся история <ChevronRightIcon /></button>
          </div>
          {latest ? (
            <button type="button" className="recent-row" onClick={() => onOpenHistory(latest)}>
              <span className="recent-icon"><ClockIcon /></span>
              <span><strong>{historyTitle(latest)}</strong><small>{latest.source}</small></span>
              <ChevronRightIcon />
            </button>
          ) : <p className="empty-history">Первый ответ появится здесь.</p>}
        </section>
      </section>
      <BottomNav active="home" onHome={() => undefined} onHistory={onHistory} onProfile={onProfile} />
    </motion.main>
  );
}

function HistoryView({ history, onOpen, onHome, onProfile }: {
  history: HistoryItem[];
  onOpen: (item: HistoryItem) => void;
  onHome: () => void;
  onProfile: () => void;
}) {
  return (
    <motion.main className="history-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="section-topbar"><div><span>Ваши ответы</span><h1>История</h1></div><ClockIcon /></header>
      <div className="history-scroll">
        {history.length ? history.map((item) => (
          <button type="button" className="history-card" key={item.id} onClick={() => onOpen(item)}>
            <span className="history-type">{item.source.toLowerCase().includes("фото") ? <CameraIcon /> : <ChatBubbleIcon />}</span>
            <span className="history-copy"><strong>{historyTitle(item)}</strong><span>{item.source}</span><time>{formatHistoryDate(item.createdAt)}</time></span>
            <ChevronRightIcon />
          </button>
        )) : (
          <div className="history-empty"><ClockIcon /><h2>История пока пустая</h2><p>Спросите что-нибудь или отправьте фотографию.</p><button type="button" onClick={onHome}>Начать</button></div>
        )}
      </div>
      <BottomNav active="history" onHome={onHome} onHistory={() => undefined} onProfile={onProfile} />
    </motion.main>
  );
}

function ProfileView({ session, busy, notice, onHome, onHistory, onStars, onBuy, onCheck }: {
  session: SessionPayload;
  busy: string;
  notice: string;
  onHome: () => void;
  onHistory: () => void;
  onStars: () => void;
  onBuy: (packageId: string) => void;
  onCheck: () => void;
}) {
  const [paymentMode, setPaymentMode] = useState<"stars" | "rubles">(session.payments.plategaEnabled ? "rubles" : "stars");
  const planLabel = session.access.plan === "pro" ? "Безлимит" : session.access.plan === "plus" ? "Plus" : "Бесплатный";
  const hasPending = session.payments.recent.some((payment) => payment.status === "pending") || Boolean(window.localStorage.getItem("poymi-pending-payment"));
  return (
    <motion.main className="profile-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="section-topbar"><div><span>Аккаунт</span><h1>Профиль</h1></div><PersonIcon /></header>
      <div className="profile-scroll">
        <section className="profile-hero">
          <div className="profile-avatar">{session.user.firstName.slice(0, 1).toUpperCase()}</div>
          <div><h1>{session.user.firstName}</h1><p>{planLabel} тариф</p></div>
        </section>

        <section className="balance-panel">
          <span>Доступно сейчас</span>
          <strong>{session.access.remaining === null ? "Безлимит" : `${session.access.remaining} запросов`}</strong>
          <small>{planLabel} тариф</small>
        </section>

        <section className="packages-section">
          <div className="section-heading"><h2>Пополнить баланс</h2><span>Запросы не сгорают</span></div>
          <div className="payment-tabs" role="tablist" aria-label="Способ оплаты">
            <button className={paymentMode === "stars" ? "active" : ""} type="button" onClick={() => setPaymentMode("stars")}><StarIcon /> Stars</button>
            {session.payments.plategaEnabled && <button className={paymentMode === "rubles" ? "active" : ""} type="button" onClick={() => setPaymentMode("rubles")}>₽ Карта / СБП</button>}
          </div>
          {paymentMode === "rubles" && session.payments.plategaEnabled ? (
            <div className="package-list">
              {session.payments.packages.map((item) => (
                <button type="button" key={item.id} disabled={Boolean(busy)} onClick={() => onBuy(item.id)}>
                  <span><strong>{item.credits}</strong><small> запросов</small></span>
                  <b>{busy === item.id ? "Открываю…" : `${item.rubles} ₽`}</b>
                  <ChevronRightIcon />
                </button>
              ))}
            </div>
          ) : (
            <div className="stars-offer"><div><strong>Plus на 30 дней</strong><span>100 AI-запросов и до 20 изображений</span></div><button type="button" onClick={onStars}>Выбрать в Telegram</button></div>
          )}
          {notice && <p className="payment-notice">{notice}</p>}
          {hasPending && <button className="check-payment" type="button" disabled={Boolean(busy)} onClick={onCheck}>Проверить оплату</button>}
        </section>

        {session.payments.recent.length > 0 && (
          <section className="purchase-section">
            <h2>Последние покупки</h2>
            {session.payments.recent.slice(0, 3).map((payment) => (
              <div key={payment.transactionId}><span>{payment.credits} запросов</span><small>{paymentStatus(payment.status)}</small><b>{payment.amountRub} ₽</b></div>
            ))}
          </section>
        )}

        <section className="documents-section">
          <div className="section-heading"><h2>Документы и помощь</h2></div>
          <div className="document-list">
            <InfoLink href="/app/tariffs" icon={<ReaderIcon />} title="Тарифы и цены" />
            <InfoLink href="/app/support" icon={<QuestionMarkCircledIcon />} title="Поддержка" />
            <InfoLink href="/app/privacy" icon={<LockClosedIcon />} title="Конфиденциальность" />
            <InfoLink href="/app/terms" icon={<FileTextIcon />} title="Условия использования" />
          </div>
        </section>
      </div>
      <BottomNav active="profile" onHome={onHome} onHistory={onHistory} onProfile={() => undefined} />
    </motion.main>
  );
}

function InfoLink({ href, icon, title }: { href: string; icon: ReactNode; title: string }) {
  return <a href={href}><span>{icon}</span><strong>{title}</strong><ChevronRightIcon /></a>;
}

function InfoPage({ pageId }: { pageId: InfoPageId }) {
  const page = INFO_PAGES[pageId];
  return (
    <main className="info-screen">
      <header className="info-topbar">
        <a href="/app/" aria-label="Вернуться в приложение"><ArrowLeftIcon /></a>
        <Brand compact />
        <span />
      </header>
      <article className="info-content">
        <span className="info-eyebrow">{page.eyebrow}</span>
        <h1>{page.title}</h1>
        <p className="info-intro">{page.intro}</p>
        <p className="info-date">Действует с 18 августа 2026 года</p>
        {page.sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {section.bullets && <ul>{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>}
          </section>
        ))}
        {pageId === "support" && (
          <a className="support-link" href="https://t.me/PoymiAI_support" target="_blank" rel="noreferrer">Написать @PoymiAI_support</a>
        )}
        <footer>Пойми AI · @OtvetUmnoAI_bot</footer>
      </article>
    </main>
  );
}

function infoPageFromPath(pathname: string): InfoPageId | undefined {
  const slug = pathname.replace(/\/+$/, "").split("/").pop();
  return slug && slug in INFO_PAGES ? slug as InfoPageId : undefined;
}

function BottomNav({ active, onHome, onHistory, onProfile }: { active: "home" | "history" | "profile"; onHome: () => void; onHistory: () => void; onProfile: () => void }) {
  return <nav className="bottom-nav" aria-label="Разделы">
    <button className={active === "home" ? "active" : ""} type="button" onClick={onHome}><HomeIcon /><span>Главная</span></button>
    <button className={active === "history" ? "active" : ""} type="button" onClick={onHistory}><ClockIcon /><span>История</span></button>
    <button className={active === "profile" ? "active" : ""} type="button" onClick={onProfile}><PersonIcon /><span>Профиль</span></button>
  </nav>;
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

function ResultView({ access, previewUrl, result, followUps, question, sending, onQuestion, onSubmit, onQuickAction, onBack }: {
  access: AccessPayload;
  previewUrl: string;
  result: string;
  followUps: Array<{ question: string; answer: string }>;
  question: string;
  sending: boolean;
  onQuestion: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onQuickAction: (question: string) => void;
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
        <div className="result-actions" aria-label="Продолжить ответ">
          <button type="button" disabled={sending} onClick={() => onQuickAction("Объясни это ещё проще и короче")}>Объяснить проще</button>
          <button type="button" disabled={sending} onClick={() => onQuickAction("Что мне делать дальше? Дай конкретные шаги")}>Что делать дальше</button>
        </div>
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
  return <div className={`brand ${compact ? "compact" : ""}`}><img src="/app/poymi-avatar-2026.jpg" alt="" /><span>Пойми AI</span></div>;
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

function historyTitle(item: HistoryItem): string {
  const source = item.source.trim();
  if (source.toLowerCase().includes("фото")) return "Разбор фотографии";
  if (source.length <= 34) return source;
  return `${source.slice(0, 34).trim()}…`;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function paymentStatus(status: "pending" | "confirmed" | "canceled" | "chargebacked"): string {
  if (status === "confirmed") return "Оплачено";
  if (status === "pending") return "Ожидает оплаты";
  if (status === "chargebacked") return "Возврат";
  return "Отменено";
}
