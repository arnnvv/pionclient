import { useEffect, useRef, type JSX } from "react";
import Hls from "hls.js";

const HLS_STREAM_URL =
  process.env.NEXT_PUBLIC_HLS_URL || "http://localhost:8080/hls/stream.m3u8";

export function WatchApp(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const videoElement = videoRef.current;
    if (!videoElement) return;

    if (Hls.isSupported()) {
      console.log("HLS.js is supported. Initializing HLS player.");
      const hls = new Hls();
      hlsRef.current = hls;

      hls.loadSource(HLS_STREAM_URL);
      hls.attachMedia(videoElement);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log("HLS Manifest parsed, attempting to play.");
        videoElement
          .play()
          .catch((e) => console.error("Error trying to play HLS stream:", e));
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error(
                "HLS.js fatal network error encountered, trying to recover:",
                data,
              );
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error(
                "HLS.js fatal media error encountered, trying to recover:",
                data,
              );
              hls.recoverMediaError();
              break;
            default:
              console.error("HLS.js fatal error:", data);
              hls.destroy();
              hlsRef.current = null;
              break;
          }
        } else {
          console.warn("HLS.js non-fatal error:", data);
        }
      });
    } else if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
      console.log(
        "Native HLS support detected (e.g., Safari). Setting src directly.",
      );
      videoElement.src = HLS_STREAM_URL;
      videoElement.addEventListener("loadedmetadata", () => {
        videoElement
          .play()
          .catch((e) =>
            console.error("Error trying to play native HLS stream:", e),
          );
      });
    } else {
      console.error("HLS is not supported in this browser.");
      alert("HLS playback is not supported in your browser.");
    }

    return () => {
      if (hlsRef.current) {
        console.log("Destroying HLS.js instance.");
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (videoElement) {
        videoElement.pause();
        videoElement.src = "";
      }
    };
  }, []);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Watch HLS Stream</h1>
      <div className="bg-black rounded overflow-hidden shadow-lg">
        <video
          ref={videoRef}
          controls
          autoPlay
          playsInline
          className="w-full aspect-video"
          onPlay={() => console.log("Video playback started.")}
          onPause={() => console.log("Video playback paused.")}
          onError={(e) => console.error("HTML Video Element Error:", e)}
        />
      </div>
      <p className="mt-2 text-sm text-gray-600">
        Attempting to play HLS stream from: {HLS_STREAM_URL}
      </p>
    </div>
  );
}
