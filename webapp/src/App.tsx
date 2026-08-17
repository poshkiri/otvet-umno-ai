import {
  ArrowLeftIcon,
  CameraIcon,
  CheckCircledIcon,
  Crosshair2Icon,
  ExclamationTriangleIcon,
  HeartIcon,
  ImageIcon,
  LightningBoltIcon,
  PaperPlaneIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { AnimatePresence, motion } from "motion/react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, miniAppApi, type AccessPayload } from "./api";
import { telegramWebApp } from "./telegram";

type View = "camera" | "scanning" | "result" | "limit" | "error";

interface ResultSection {
  title: string;
  body: string;
}

const DEMO_RESULT = [
  "📷 Что на фото",
  "Это набор уходовой косметики SADOER из линейки Grape Seed с экстрактом виноградных косточек.",
  "",
  "🧴 Что входит",
  "В наборе видны очищающее средство, тонер или лосьон, сыворотка, эмульсия, крем в баночке, крем для области вокруг глаз и четыре ампулы.",
  "",
  "💡 Что это значит",
  "Средства предназначены для последовательного очищения, увлажнения и ухода за кожей лица.",
  "",
  "✅ Как использовать",
  "Обычно начинают с очищения, затем используют тонер, сыворотку, эмульсию и крем. Точный порядок лучше подтвердить по обратной стороне упаковки.",
].join("\n");

export default function App() {
  const telegram = useMemo(() => telegramWebApp(), []);
  const isDemo = !telegram?.initData;
  const [view, setView] = useState<View>("camera");
  const [previewUrl, setPreviewUrl] = useState(isDemo ? "/app/sample-product.jpg" : "");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [stream, setStream] = useState<MediaStream>();
  const [torchOn, setTorchOn] = useState(false);
  const [access, setAccess] = useState<AccessPayload>({ remaining: 5, label: "5 запросов", plan: "free" });
  const [botUsername, setBotUsername] = useState("OtvetUmnoAI_bot");
  const [result, setResult] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [followUps, setFollowUps] = useState<Array<{ question: string; answer: string }>>([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    telegram?.ready();
    telegram?.expand();
    telegram?.setHeaderColor?.("#050706");
    telegram?.setBackgroundColor?.("#050706");
    if (!telegram?.initData) return;
    miniAppApi.session(telegram.initData)
      .then((session) => {
        setAccess(session.access);
        setBotUsername(session.botUsername);
      })
      .catch((reason: unknown) => showError(reason));
  }, [telegram]);

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream]);

  useEffect(() => () => stopCamera(stream), [stream]);

  const showError = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : "Что-то пошло не так";
    setError(message);
    setView(reason instanceof ApiError && reason.code === "LIMIT_REACHED" ? "limit" : "error");
    telegram?.HapticFeedback?.notificationOccurred("error");
  };

  const startCamera = async () => {
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      stopCamera(stream);
      setSelectedFile(undefined);
      if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
      setPreviewUrl("");
      setStream(nextStream);
      telegram?.HapticFeedback?.impactOccurred("light");
    } catch {
      setError("Не получилось открыть камеру. Разреши доступ или выбери фото из галереи.");
      setView("error");
    }
  };

  const chooseFile = (file?: File) => {
    if (!file) return;
    if (!file.type.match(/^image\/(jpeg|png|webp)$/)) {
      setError("Выбери фотографию JPG, PNG или WebP.");
      setView("error");
      return;
    }
    stopCamera(stream);
    setStream(undefined);
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    telegram?.HapticFeedback?.impactOccurred("light");
  };

  const captureFrame = async (): Promise<File | undefined> => {
    const element = video.current;
    if (!element || !element.videoWidth || !element.videoHeight) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    canvas.getContext("2d")?.drawImage(element, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return blob ? new File([blob], "camera.jpg", { type: "image/jpeg" }) : undefined;
  };

  const analyze = async () => {
    if (!selectedFile && !stream && !isDemo) {
      await startCamera();
      return;
    }
    const file = selectedFile ?? await captureFrame();
    if (!file && !isDemo) {
      setError("Камера ещё не готова. Подожди секунду и попробуй снова.");
      setView("error");
      return;
    }
    if (file && !previewUrl) setPreviewUrl(URL.createObjectURL(file));
    stopCamera(stream);
    setStream(undefined);
    setView("scanning");
    telegram?.HapticFeedback?.impactOccurred("medium");
    try {
      if (isDemo) {
        await wait(1_450);
        setResult(DEMO_RESULT);
        setConversationId("demo");
        setAccess({ ...access, remaining: Math.max(0, (access.remaining ?? 5) - 1), label: "4 запроса" });
      } else {
        const response = await miniAppApi.analyze(telegram!.initData, file!);
        setResult(response.result);
        setConversationId(response.conversationId);
        setAccess(response.access);
      }
      setFollowUps([]);
      setView("result");
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch (reason) {
      showError(reason);
    }
  };

  const toggleTorch = async () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) {
      setTorchOn((value) => !value);
      return;
    }
    const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    if (!capabilities.torch) {
      telegram?.HapticFeedback?.notificationOccurred("warning");
      return;
    }
    const next = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
    setTorchOn(next);
  };

  const askFollowUp = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setQuestion("");
    try {
      const answer = isDemo
        ? "Для утреннего ухода начни с очищения, затем используй тонер, сыворотку и лёгкий крем."
        : (await miniAppApi.followUp(telegram!.initData, conversationId, trimmed)).result;
      setFollowUps((items) => [...items, { question: trimmed, answer }]);
      if (!isDemo) {
        const session = await miniAppApi.session(telegram!.initData);
        setAccess(session.access);
      }
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch (reason) {
      showError(reason);
    } finally {
      setSending(false);
    }
  };

  const openPlans = () => {
    telegram?.openTelegramLink(`https://t.me/${botUsername}?start=miniapp_plus`);
  };

  const resetCamera = () => {
    setView("camera");
    setError("");
    setResult("");
    setConversationId("");
    setFollowUps([]);
  };

  return (
    <div className="app">
      <AnimatePresence mode="wait">
        {view === "camera" && (
          <CameraView
            access={access}
            previewUrl={previewUrl}
            stream={stream}
            videoRef={video}
            torchOn={torchOn}
            onStartCamera={startCamera}
            onGallery={() => fileInput.current?.click()}
            onAnalyze={analyze}
            onTorch={toggleTorch}
          />
        )}
        {view === "scanning" && <ScanningView previewUrl={previewUrl} />}
        {view === "result" && (
          <ResultView
            access={access}
            previewUrl={previewUrl}
            result={result}
            followUps={followUps}
            question={question}
            sending={sending}
            onQuestion={setQuestion}
            onSubmit={askFollowUp}
            onBack={resetCamera}
          />
        )}
        {view === "limit" && <MessageView title="Запросы закончились" text={error} action="Посмотреть Plus" onAction={openPlans} onBack={resetCamera} />}
        {view === "error" && <MessageView title="Не получилось" text={error} action="Попробовать ещё раз" onAction={resetCamera} onBack={resetCamera} />}
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

function CameraView({ access, previewUrl, stream, videoRef, torchOn, onStartCamera, onGallery, onAnalyze, onTorch }: {
  access: AccessPayload;
  previewUrl: string;
  stream?: MediaStream;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  torchOn: boolean;
  onStartCamera: () => void;
  onGallery: () => void;
  onAnalyze: () => void;
  onTorch: () => void;
}) {
  return (
    <motion.main className="camera-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="topbar">
        <Brand />
        <span className="access"><strong>{access.remaining === null ? "∞" : access.remaining}</strong> {access.remaining === null ? "" : "запросов"}<i /></span>
      </header>
      <section className="viewfinder">
        {stream ? <video ref={videoRef} autoPlay muted playsInline /> : previewUrl ? <img src={previewUrl} alt="Предмет для распознавания" /> : (
          <button className="enable-camera" type="button" onClick={onStartCamera}><CameraIcon />Включить камеру</button>
        )}
        <div className="focus-frame" aria-hidden="true"><span /><span /><span /><span /></div>
        <Crosshair2Icon className="crosshair" aria-hidden="true" />
        <motion.div className="scan-line" animate={{ top: ["18%", "78%", "18%"] }} transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }} />
        <div className="found"><CheckCircledIcon /> Объект найден</div>
      </section>
      <section className="controls">
        <button className="round-button" type="button" onClick={onGallery} aria-label="Открыть галерею"><ImageIcon /></button>
        <button className="shutter" type="button" onClick={onAnalyze} aria-label={stream || previewUrl ? "Распознать предмет" : "Включить камеру"}><img src="/app/poymi-logo.png" alt="" /></button>
        <button className={`round-button ${torchOn ? "is-active" : ""}`} type="button" onClick={onTorch} aria-label="Вспышка"><LightningBoltIcon /></button>
      </section>
      <p className="hint">Снимите предмет целиком</p>
    </motion.main>
  );
}

function ScanningView({ previewUrl }: { previewUrl: string }) {
  return (
    <motion.main className="scanning-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <Brand />
      <div className="scanning-image">{previewUrl && <img src={previewUrl} alt="Анализируемый предмет" />}<motion.div animate={{ top: ["12%", "84%", "12%"] }} transition={{ duration: 1.4, repeat: Infinity }} /></div>
      <Crosshair2Icon />
      <h1>Изучаю фотографию</h1>
      <p>Распознаю предметы и читаю надписи</p>
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
  const headline = sections[0]?.body.split(/[.!?\n]/)[0] || "Результат распознавания";
  return (
    <motion.main className="result-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="result-topbar">
        <button type="button" onClick={onBack} aria-label="Назад"><ArrowLeftIcon /></button>
        <Brand compact />
        <span className="result-access"><HeartIcon /><strong>{access.remaining === null ? "∞" : access.remaining}</strong></span>
      </header>
      <div className="result-scroll">
        <div className="result-photo">{previewUrl && <img src={previewUrl} alt="Распознанный предмет" />}</div>
        <section className="summary">
          <span>Результат распознавания</span>
          <h1>{headline}</h1>
          <p><CheckCircledIcon /> Объект распознан по фотографии</p>
        </section>
        {sections.map((section, index) => (
          <section className="result-section" key={`${section.title}-${index}`}>
            <div>{index === sections.length - 1 && section.title.includes("Важно") ? <ExclamationTriangleIcon /> : <Crosshair2Icon />}</div>
            <article><h2>{section.title}</h2><p>{section.body}</p></article>
          </section>
        ))}
        {followUps.map((item, index) => (
          <section className="follow-up-answer" key={`${item.question}-${index}`}><small>Ваш вопрос</small><h2>{item.question}</h2><p>{item.answer}</p></section>
        ))}
        <div className="scroll-space" />
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <CameraIcon />
        <input value={question} onChange={(event) => onQuestion(event.target.value)} placeholder="Спросить по этому фото" aria-label="Вопрос по фотографии" />
        <button type="submit" disabled={!question.trim() || sending} aria-label="Отправить вопрос">{sending ? <ReloadIcon className="spin" /> : <PaperPlaneIcon />}</button>
      </form>
    </motion.main>
  );
}

function MessageView({ title, text, action, onAction, onBack }: { title: string; text: string; action: string; onAction: () => void; onBack: () => void }) {
  return (
    <motion.main className="message-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <Brand />
      <div><ExclamationTriangleIcon /><h1>{title}</h1><p>{text}</p><button type="button" onClick={onAction}>{action}</button><button className="secondary" type="button" onClick={onBack}>Назад к камере</button></div>
    </motion.main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "compact" : ""}`}><img src="/app/poymi-logo.png" alt="" /><span>Пойми AI</span></div>;
}

function parseResult(result: string): ResultSection[] {
  const headings = /^(📷 Что на фото|🧴 Что входит|💡 Что это значит|✅ Как использовать|⚠️ Важно)$/;
  const sections: ResultSection[] = [];
  let current: ResultSection | undefined;
  for (const rawLine of result.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (headings.test(line)) {
      if (current?.body) sections.push(current);
      current = { title: line.replace(/^\S+\s*/, ""), body: "" };
    } else if (current) {
      current.body += `${current.body ? "\n" : ""}${line}`;
    } else {
      current = { title: "Что на фото", body: line };
    }
  }
  if (current?.body) sections.push(current);
  return sections.length ? sections : [{ title: "Разбор", body: result }];
}

function stopCamera(stream?: MediaStream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
