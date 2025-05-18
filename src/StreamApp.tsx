import { useEffect, useRef, useState, type JSX } from "react";
import type {
  CandidatePayload,
  DirectSignalPayload,
  SDPPayload,
  SignalingMessage,
} from "./../types";
import { v4 } from "./../uuid";

const WS_URL_BASE =
  process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080/ws/stream";

export function StreamApp(): JSX.Element {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [clientId] = useState<string>(() => v4());
  const ws = useRef<WebSocket | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);

  const serverPc = useRef<RTCPeerConnection | null>(null);
  const serverPcSenders = useRef<Map<string, RTCRtpSender>>(new Map());

  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreams = useRef<Map<string, MediaStream>>(new Map());
  const [displayedRemoteStreams, setDisplayedRemoteStreams] = useState<
    Map<string, MediaStream>
  >(new Map());

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement | null>>(
    new Map(),
  );

  const sendSignalingMessage = (message: SignalingMessage) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      console.log(`[${clientId.substring(0, 8)}] Sending:`, message.type);
      ws.current.send(JSON.stringify(message));
    } else {
      console.error(
        `[${clientId.substring(0, 8)}] WebSocket not open. Cannot send message:`,
        message.type,
      );
    }
  };

  const createServerPeerConnection = (): RTCPeerConnection | null => {
    if (serverPc.current) {
      console.log(`[${clientId.substring(0, 8)}] Server PC already exists.`);
      return serverPc.current;
    }
    console.log(
      `[${clientId.substring(0, 8)}] Creating Server PeerConnection (for HLS)`,
    );
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignalingMessage({
          type: "candidate",
          payload: { candidate: event.candidate.toJSON() } as CandidatePayload,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(
        `[${clientId.substring(0, 8)}] Server PC ICE state: ${pc.iceConnectionState}`,
      );
      if (
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "disconnected"
      ) {
        console.warn(
          `[${clientId.substring(0, 8)}] Server PC disconnected or failed. Attempting to clean up.`,
        );
        serverPc.current?.close();
        serverPc.current = null;
        serverPcSenders.current.clear();
      }
    };
    serverPc.current = pc;
    return pc;
  };

  const createAndSendOfferToServerPc = async () => {
    if (!serverPc.current) {
      console.error(
        `[${clientId.substring(0, 8)}] Server PC not ready for offer.`,
      );
      return;
    }
    if (
      serverPc.current.getSenders().filter((s) => s.track).length === 0 &&
      localStream
    ) {
      console.log(
        `[${clientId.substring(0, 8)}] Tracks not yet fully added to server PC. Retrying offer creation shortly.`,
      );
      setTimeout(createAndSendOfferToServerPc, 100);
      return;
    }
    if (
      serverPc.current.getSenders().filter((s) => s.track).length === 0 &&
      !localStream
    ) {
      console.warn(
        `[${clientId.substring(0, 8)}] No local stream, cannot create offer for server PC.`,
      );
      return;
    }

    try {
      console.log(
        `[${clientId.substring(0, 8)}] Creating offer for Server PC. Current signaling state: ${serverPc.current.signalingState}`,
      );

      const offer = await serverPc.current.createOffer();
      await serverPc.current.setLocalDescription(offer);
      sendSignalingMessage({
        type: "offer",
        payload: {
          sdp: serverPc.current.localDescription?.toJSON(),
        } as SDPPayload,
      });
    } catch (error) {
      console.error(
        `[${clientId.substring(0, 8)}] Error creating/sending offer to Server PC:`,
        error,
      );
    }
  };

  const createP2PConnection = (peerId: string): RTCPeerConnection => {
    if (peerConnections.current.has(peerId)) {
      const p2pconnection = peerConnections.current.get(peerId);
      if (!p2pconnection) throw new Error("P2PConnection dosent exist");
      return p2pconnection;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignalingMessage({
          type: "direct-candidate",
          payload: {
            candidate: event.candidate.toJSON(),
            toPeerID: peerId,
          } as DirectSignalPayload,
        });
      }
    };

    pc.ontrack = (event) => {
      let stream = remoteStreams.current.get(peerId);
      if (!stream) {
        stream = new MediaStream();
        remoteStreams.current.set(peerId, stream);
      }
      stream.addTrack(event.track);
      setDisplayedRemoteStreams((prev) => new Map(prev).set(peerId, stream));
    };

    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === "disconnected" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "failed"
      ) {
        peerConnections.current.get(peerId)?.close();
        peerConnections.current.delete(peerId);
        remoteStreams.current.delete(peerId);
        setDisplayedRemoteStreams((prev) => {
          const newMap = new Map(prev);
          newMap.delete(peerId);
          return newMap;
        });
      }
    };

    if (localStream) {
      for (const track of localStream.getTracks()) {
        try {
          pc.addTrack(track, localStream);
        } catch (e) {
          console.error(
            `[${clientId.substring(0, 8)}] Error adding initial track to P2P PC (${peerId.substring(0, 8)}):`,
            e,
          );
        }
      }
    }

    peerConnections.current.set(peerId, pc);
    return pc;
  };

  const handleInitiateP2P = (fromPeerID: string) => {
    if (fromPeerID === clientId || peerConnections.current.has(fromPeerID))
      return;
    const p2pPc = createP2PConnection(fromPeerID);
    p2pPc
      .createOffer()
      .then((offer) => p2pPc.setLocalDescription(offer))
      .then(() => {
        if (p2pPc.localDescription) {
          sendSignalingMessage({
            type: "direct-offer",
            payload: {
              sdp: p2pPc.localDescription.toJSON(),
              toPeerID: fromPeerID,
            } as DirectSignalPayload,
          });
        }
      })
      .catch((e) => console.error(e));
  };

  const handleDirectOffer = async (
    fromPeerID: string,
    sdp: RTCSessionDescriptionInit,
  ) => {
    if (fromPeerID === clientId) return;
    const p2pPc = createP2PConnection(fromPeerID);
    try {
      await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await p2pPc.createAnswer();
      await p2pPc.setLocalDescription(answer);
      if (p2pPc.localDescription) {
        sendSignalingMessage({
          type: "direct-answer",
          payload: {
            sdp: p2pPc.localDescription.toJSON(),
            toPeerID: fromPeerID,
          } as DirectSignalPayload,
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDirectAnswer = async (
    fromPeerID: string,
    sdp: RTCSessionDescriptionInit,
  ) => {
    const p2pPc = peerConnections.current.get(fromPeerID);
    if (p2pPc) {
      try {
        await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (e) {
        console.error(e);
      }
    }
  };

  const handleDirectCandidate = async (
    fromPeerID: string,
    candidateInit: RTCIceCandidateInit,
  ) => {
    const p2pPc = peerConnections.current.get(fromPeerID);
    if (p2pPc && p2pPc.signalingState !== "closed") {
      try {
        await p2pPc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (e) {
        console.error(e);
      }
    }
  };

  useEffect(() => {
    const wsUrlWithClientId = `${WS_URL_BASE}?clientId=${clientId}`;
    console.log(
      `[${clientId.substring(0, 8)}] Attempting to connect WebSocket to ${wsUrlWithClientId}`,
    );
    const socket = new WebSocket(wsUrlWithClientId);
    ws.current = socket;

    socket.onopen = () => {
      console.log(`[${clientId.substring(0, 8)}] WebSocket connected.`);
      setIsWsConnected(true);
      sendSignalingMessage({
        type: "signal-initiate-p2p",
        payload: { clientId: clientId },
      });
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data as string) as SignalingMessage;
        console.log(
          `[${clientId.substring(0, 8)}] Received message:`,
          message.type,
        );

        switch (message.type) {
          case "answer":
            if (
              serverPc.current &&
              message.payload.sdp &&
              serverPc.current.signalingState !== "closed"
            ) {
              await serverPc.current.setRemoteDescription(
                new RTCSessionDescription(message.payload.sdp),
              );
            }
            break;
          case "candidate":
            if (
              serverPc.current &&
              message.payload.candidate &&
              serverPc.current.signalingState !== "closed"
            ) {
              await serverPc.current.addIceCandidate(
                new RTCIceCandidate(message.payload.candidate),
              );
            }
            break;
          case "signal-initiate-p2p":
            if (
              message.payload.fromPeerID &&
              message.payload.fromPeerID !== clientId
            ) {
              handleInitiateP2P(message.payload.fromPeerID);
            }
            break;
          case "direct-offer":
            if (message.payload.fromPeerID && message.payload.sdp) {
              await handleDirectOffer(
                message.payload.fromPeerID,
                message.payload.sdp,
              );
            }
            break;
          case "direct-answer":
            if (message.payload.fromPeerID && message.payload.sdp) {
              await handleDirectAnswer(
                message.payload.fromPeerID,
                message.payload.sdp,
              );
            }
            break;
          case "direct-candidate":
            if (message.payload.fromPeerID && message.payload.candidate) {
              await handleDirectCandidate(
                message.payload.fromPeerID,
                message.payload.candidate,
              );
            }
            break;
          default:
            console.warn(
              `[${clientId.substring(0, 8)}] Unknown message type: ${message.type}`,
            );
        }
      } catch (error) {
        console.error(error, event.data);
      }
    };

    socket.onerror = (error) => {
      console.error(`[${clientId.substring(0, 8)}] WebSocket error:`, error);
      setIsWsConnected(false);
    };

    socket.onclose = (event) => {
      console.log(
        `[${clientId.substring(0, 8)}] WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`,
      );
      ws.current = null;
      setIsWsConnected(false);
    };

    return () => {
      console.log(
        `[${clientId.substring(0, 8)}] Cleaning up WebSocket and PeerConnections.`,
      );
      serverPc.current?.close();
      serverPc.current = null;
      serverPcSenders.current.clear();
      for (const [, pc] of peerConnections.current) {
        pc.close();
      }
      peerConnections.current.clear();
      remoteStreams.current.clear();
      setDisplayedRemoteStreams(new Map());
      if (ws.current) {
        ws.current.onopen = null;
        ws.current.onmessage = null;
        ws.current.onerror = null;
        ws.current.onclose = null;
        ws.current.close();
      }
      ws.current = null;
      setIsWsConnected(false);
      if (localStream) {
        for (const track of localStream.getTracks()) {
          track.stop();
        }
        setLocalStream(null);
      }
    };
  }, [clientId]);

  const startStreaming = async () => {
    try {
      console.log(`[${clientId.substring(0, 8)}] Requesting local media...`);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      console.log(`[${clientId.substring(0, 8)}] Local media obtained.`);
    } catch (error) {
      console.error(
        `[${clientId.substring(0, 8)}] Error accessing media devices:`,
        error,
      );
      alert("Could not access camera/microphone. Please check permissions.");
    }
  };

  useEffect(() => {
    if (localStream && isWsConnected) {
      console.log(
        `[${clientId.substring(0, 8)}] Local stream and WebSocket ready. Initiating connections.`,
      );
      initiateConnectionsAfterMedia(localStream);
    }
  }, [localStream, isWsConnected]);

  const initiateConnectionsAfterMedia = async (
    currentLocalStream: MediaStream,
  ) => {
    let sPC = serverPc.current;
    if (!sPC) {
      sPC = createServerPeerConnection();
    }

    if (sPC) {
      console.log(
        `[${clientId.substring(0, 8)}] Processing tracks for Server PC.`,
      );
      let tracksChangedOrAdded = false;
      for (const track of currentLocalStream.getTracks()) {
        const existingSender = serverPcSenders.current.get(track.kind);
        if (existingSender) {
          if (existingSender.track && existingSender.track.id !== track.id) {
            console.log(
              `[${clientId.substring(0, 8)}] Replacing track in Server PC: ${track.kind}`,
            );
            await existingSender
              .replaceTrack(track)
              .catch((e) => console.error(e));
            tracksChangedOrAdded = true;
          } else if (!existingSender.track) {
            await existingSender
              .replaceTrack(track)
              .catch((e) => console.error(e));
            tracksChangedOrAdded = true;
          }
        } else {
          try {
            const newSender = sPC.addTrack(track, currentLocalStream);
            serverPcSenders.current.set(track.kind, newSender);
            tracksChangedOrAdded = true;
          } catch (e) {
            console.error(e);
          }
        }
      }

      if (
        tracksChangedOrAdded ||
        sPC.getSenders().filter((s) => s.track).length > 0
      ) {
        await createAndSendOfferToServerPc();
      }
    }

    peerConnections.current.forEach(async (p2pPc, peerId) => {
      let p2pTracksChanged = false;
      for (const track of currentLocalStream.getTracks()) {
        const sender = p2pPc
          .getSenders()
          .find((s) => s.track?.kind === track.kind);
        if (sender) {
          if (sender.track && sender.track.id !== track.id) {
            await sender.replaceTrack(track).catch((e) => console.error(e));
            p2pTracksChanged = true;
          } else if (!sender.track) {
            await sender.replaceTrack(track).catch((e) => console.error(e));
            p2pTracksChanged = true;
          }
        } else {
          try {
            p2pPc.addTrack(track, currentLocalStream);
            p2pTracksChanged = true;
          } catch (e) {
            console.error(e);
          }
        }
      }
      if (p2pTracksChanged && p2pPc.signalingState === "stable") {
        console.log(
          `[${clientId.substring(0, 8)}] Renegotiating P2P with ${peerId.substring(0, 8)} due to track changes.`,
        );
        p2pPc
          .createOffer()
          .then((offer) => p2pPc.setLocalDescription(offer))
          .then(() => {
            if (p2pPc.localDescription) {
              sendSignalingMessage({
                type: "direct-offer",
                payload: {
                  sdp: p2pPc.localDescription.toJSON(),
                  toPeerID: peerId,
                },
              });
            }
          })
          .catch((e) => console.error("Error renegotiating P2P offer:", e));
      }
    });
  };

  useEffect(() => {
    displayedRemoteStreams.forEach((stream, peerId) => {
      const videoElement = remoteVideoRefs.current.get(peerId);
      if (videoElement && videoElement.srcObject !== stream) {
        videoElement.srcObject = stream;
      }
    });
  }, [displayedRemoteStreams]);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">
        Stream Page (Client ID: {clientId.substring(0, 8)})
      </h1>

      {!localStream ? (
        <button
          type="button"
          onClick={startStreaming}
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded mb-4"
        >
          Start Camera & Mic
        </button>
      ) : (
        <p className="text-green-600 mb-4">
          Streaming active. Your ID: {clientId.substring(0, 8)}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h2 className="text-xl">Your Video</h2>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full bg-gray-800 rounded"
          />
        </div>

        {Array.from(displayedRemoteStreams.entries()).map(([peerId]) => (
          <div key={peerId}>
            <h2 className="text-xl">
              Remote Stream from {peerId.substring(0, 8)}
            </h2>
            <video
              ref={(el) => {
                remoteVideoRefs.current.set(peerId, el);
              }}
              autoPlay
              playsInline
              className="w-full bg-gray-700 rounded"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
