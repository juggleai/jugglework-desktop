import { bindMeetingVideo } from "../../../src/react-app/domains/meeting/video-view";

// Exercise real Chromium audio across windows, without credentials or external RTC.
(window as any).runAudioWindowCheck = async (legacy = false) => {
  const context = new AudioContext();
  const sender = new RTCPeerConnection();
  const receiver = new RTCPeerConnection();
  const output = context.createMediaStreamDestination();
  const tone = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.02;
  tone.frequency.value = 660;
  tone.connect(gain).connect(output);
  const audio = document.createElement("audio");
  audio.volume = 0.1;
  document.body.append(audio);
  const child = window.open("about:blank", `audio-regression-${crypto.randomUUID()}`, "popup,width=400,height=250");
  if (!child) throw new Error("test child window blocked");
  let binding: ReturnType<typeof bindMeetingVideo> | undefined;
  let canvasStream: MediaStream | undefined;
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let candidatesReady!: () => void;
  const ready = new Promise<void>(resolve => { candidatesReady = resolve; });
  sender.onicecandidate = e => { if (e.candidate) void ready.then(() => receiver.addIceCandidate(e.candidate!)).catch(() => {}); };
  receiver.onicecandidate = e => { if (e.candidate) void ready.then(() => sender.addIceCandidate(e.candidate!)).catch(() => {}); };
  const streamReady = new Promise<MediaStream>(resolve => { receiver.ontrack = e => resolve(e.streams[0]); });
  const levels = async () => {
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      await delay(300);
      const stats = await receiver.getStats();
      stats.forEach(s => { if (s.type === "inbound-rtp" && s.kind === "audio") values.push(s.audioLevel || 0); });
    }
    return Math.max(...values);
  };
  try {
    await context.resume();
    tone.start();
    sender.addTrack(output.stream.getAudioTracks()[0], output.stream);
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription!);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription!);
    candidatesReady();
    const received = await Promise.race([streamReady, delay(8000).then(() => { throw new Error("RTC track timeout"); })]);
    audio.srcObject = received;
    await audio.play();
    await delay(1000);
    const baseline = await levels();
    const video = child.document.createElement("video");
    video.muted = true;
    child.document.body.append(video);
    if (legacy) { video.srcObject = received; await video.play(); }
    else binding = bindMeetingVideo(video, received);
    await delay(500);
    const withChild = await levels();
    const audioTracksInVideo = (video.srcObject as MediaStream)?.getAudioTracks().length;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 16);
    canvasStream = canvas.captureStream(5);
    const camera = canvasStream.getVideoTracks()[0];
    received.addTrack(camera);
    binding?.sync();
    const videoTracks = (video.srcObject as MediaStream)?.getVideoTracks().length;
    const withVideo = await levels();
    received.removeTrack(camera);
    binding?.sync();
    child.blur();
    const afterVideo = await levels();
    const result = { legacy, baseline, withChild, withVideo, afterVideo, audioTracksInVideo, videoTracks };
    if (!(baseline > 0.0005)) throw new Error(`test audio missing: ${JSON.stringify(result)}`);
    if (!legacy && (audioTracksInVideo !== 0 || videoTracks !== 1 || [withChild, withVideo, afterVideo].some(v => v < baseline * 0.4)))
      throw new Error(`cross-window audio regression: ${JSON.stringify(result)}`);
    return result;
  } finally {
    binding?.dispose();
    child.close();
    audio.pause(); audio.srcObject = null; audio.remove();
    sender.close(); receiver.close();
    tone.stop();
    output.stream.getTracks().forEach(t => t.stop());
    canvasStream?.getTracks().forEach(t => t.stop());
    await context.close();
  }
};
