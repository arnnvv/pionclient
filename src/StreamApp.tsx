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
  const pendingServerCandidates = useRef<RTCIceCandidateInit[]>([]);

  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreams = useRef<Map<string, MediaStream>>(new Map());
  const [displayedRemoteStreams, setDisplayedRemoteStreams] = useState<
    Map<string, MediaStream>
  >(new Map());
  const pendingP2PCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(
    new Map(),
  );

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement | null>>(
    new Map(),
  );

  const sendSignalingMessage = (message: SignalingMessage) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(message));
    }
  };

  const createServerPeerConnection = (): RTCPeerConnection | null => {
    if (serverPc.current) {
      return serverPc.current;
    }
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
      if (
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "disconnected"
      ) {
        serverPc.current?.close();
        serverPc.current = null;
        serverPcSenders.current.clear();
        pendingServerCandidates.current = [];
      }
    };
    serverPc.current = pc;
    return pc;
  };

  const createAndSendOfferToServerPc = async () => {
    if (!serverPc.current) {
      return;
    }
    if (
      serverPc.current.getSenders().filter((s) => s.track).length === 0 &&
      localStream
    ) {
      setTimeout(createAndSendOfferToServerPc, 200);
      return;
    }
    if (
      serverPc.current.getSenders().filter((s) => s.track).length === 0 &&
      !localStream
    ) {
      return;
    }

    try {
      const offer = await serverPc.current.createOffer();
      await serverPc.current.setLocalDescription(offer);
      sendSignalingMessage({
        type: "offer",
        payload: {
          sdp: serverPc.current.localDescription?.toJSON(),
        } as SDPPayload,
      });
    } catch (error) {
      console.error(error);
    }
  };

  const createP2PConnection = (peerId: string): RTCPeerConnection => {
    if (peerConnections.current.has(peerId)) {
      const p2pconnection = peerConnections.current.get(peerId);
      if (!p2pconnection)
        throw new Error("P2PConnection does not exist but was in map");
      return p2pconnection;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peerConnections.current.set(peerId, pc);

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
      setDisplayedRemoteStreams((prev) => new Map(prev).set(peerId, stream!));
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
        pendingP2PCandidates.current.delete(peerId);
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
          console.error(e);
        }
      }
    }
    return pc;
  };

  const handleInitiateP2P = (fromPeerID: string) => {
    if (fromPeerID === clientId) return;
    if (peerConnections.current.has(fromPeerID)) {
      return;
    }
    const p2pPc = createP2PConnection(fromPeerID);

    p2pPc
      .createOffer()
      .then((offer) => {
        return p2pPc.setLocalDescription(offer);
      })
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
      .catch(() => {});
  };

  const handleDirectOffer = async (
    fromPeerID: string,
    sdp: RTCSessionDescriptionInit,
  ) => {
    if (fromPeerID === clientId) return;
    const p2pPc = createP2PConnection(fromPeerID);
    try {
      await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));

      const candidates = pendingP2PCandidates.current.get(fromPeerID);
      if (candidates) {
        for (const candidate of candidates) {
          try {
            await p2pPc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error(e);
          }
        }
        pendingP2PCandidates.current.delete(fromPeerID);
      }

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
    if (fromPeerID === clientId) return;
    const p2pPc = peerConnections.current.get(fromPeerID);
    if (p2pPc) {
      try {
        await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));
        const candidates = pendingP2PCandidates.current.get(fromPeerID);
        if (candidates) {
          for (const candidate of candidates) {
            try {
              await p2pPc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
              console.error(e);
            }
          }
          pendingP2PCandidates.current.delete(fromPeerID);
        }
      } catch (e) {
        console.error(e);
      }
    }
  };

  const handleDirectCandidate = async (
    fromPeerID: string,
    candidateInit: RTCIceCandidateInit,
  ) => {
    if (fromPeerID === clientId) return;
    const p2pPc = peerConnections.current.get(fromPeerID);
    if (p2pPc) {
      if (p2pPc.remoteDescription && p2pPc.signalingState !== "closed") {
        try {
          await p2pPc.addIceCandidate(new RTCIceCandidate(candidateInit));
        } catch (e) {
          console.error(e);
        }
      } else {
        const peerCandidates =
          pendingP2PCandidates.current.get(fromPeerID) || [];
        peerCandidates.push(candidateInit);
        pendingP2PCandidates.current.set(fromPeerID, peerCandidates);
      }
    }
  };

  useEffect(() => {
    const wsUrlWithClientId = `${WS_URL_BASE}?clientId=${clientId}`;
    const socket = new WebSocket(wsUrlWithClientId);
    ws.current = socket;

    socket.onopen = () => {
      setIsWsConnected(true);
      sendSignalingMessage({
        type: "signal-initiate-p2p",
        payload: { clientId: clientId },
      });
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data as string) as SignalingMessage;

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
              if (pendingServerCandidates.current.length > 0) {
                for (const candidate of pendingServerCandidates.current) {
                  try {
                    await serverPc.current.addIceCandidate(
                      new RTCIceCandidate(candidate),
                    );
                  } catch (e) {
                    console.error(e);
                  }
                }
                pendingServerCandidates.current = [];
              }
            }
            break;
          case "candidate":
            if (
              serverPc.current &&
              message.payload.candidate &&
              serverPc.current.signalingState !== "closed"
            ) {
              if (serverPc.current.remoteDescription) {
                await serverPc.current.addIceCandidate(
                  new RTCIceCandidate(message.payload.candidate),
                );
              } else {
                pendingServerCandidates.current.push(
                  message.payload.candidate as RTCIceCandidateInit,
                );
              }
            }
            break;
          case "signal-initiate-p2p":
            if (
              message.payload.fromPeerID &&
              message.payload.fromPeerID !== clientId
            ) {
              if (!peerConnections.current.has(message.payload.fromPeerID)) {
                handleInitiateP2P(message.payload.fromPeerID);
              }
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
            break;
        }
      } catch (error) {
        console.error(error);
      }
    };

    socket.onerror = () => {
      setIsWsConnected(false);
    };

    socket.onclose = () => {
      ws.current = null;
      setIsWsConnected(false);
    };

    return () => {
      serverPc.current?.close();
      serverPc.current = null;
      serverPcSenders.current.clear();
      pendingServerCandidates.current = [];

      for (const [, pc] of peerConnections.current) {
        pc.close();
      }
      peerConnections.current.clear();
      remoteStreams.current.clear();
      pendingP2PCandidates.current.clear();
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
  }, [clientId, localStream]);

  const startStreaming = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (error) {
      alert("Could not access camera/microphone. Please check permissions.");
    }
  };

  useEffect(() => {
    if (localStream && isWsConnected) {
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
      let tracksChangedOrAddedToHLS = false;
      for (const track of currentLocalStream.getTracks()) {
        const existingSender = serverPcSenders.current.get(track.kind);
        if (existingSender) {
          if (existingSender.track?.id !== track.id) {
            await existingSender.replaceTrack(track).catch(() => {});
            tracksChangedOrAddedToHLS = true;
          }
        } else {
          try {
            const newSender = sPC.addTrack(track, currentLocalStream);
            serverPcSenders.current.set(track.kind, newSender);
            tracksChangedOrAddedToHLS = true;
          } catch (e) {
            console.error(e);
          }
        }
      }

      if (sPC.signalingState === "stable" && tracksChangedOrAddedToHLS) {
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
          if (sender.track?.id !== track.id) {
            await sender.replaceTrack(track).catch(() => {});
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
                } as DirectSignalPayload,
              });
            }
          })
          .catch(() => {});
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
        Stream Page (My ID: {clientId.substring(0, 8)})
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
        <p className="text-green-600 mb-4">Streaming active.</p>
      )}
      <p className="text-sm text-gray-500 mb-2">
        WebSocket: {isWsConnected ? "Connected" : "Disconnected"}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <h2 className="text-xl">Your Video ({clientId.substring(0, 8)})</h2>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full bg-gray-800 rounded aspect-video"
          />
        </div>

        {Array.from(displayedRemoteStreams.entries()).map(
          ([peerId, stream]) => (
            <div key={peerId}>
              <h2 className="text-xl">
                Remote Stream from {peerId.substring(0, 8)}
              </h2>
              <video
                ref={(el) => {
                  if (el) {
                    remoteVideoRefs.current.set(peerId, el);
                    if (el.srcObject !== stream) el.srcObject = stream;
                  } else {
                    remoteVideoRefs.current.delete(peerId);
                  }
                }}
                autoPlay
                playsInline
                className="w-full bg-gray-700 rounded aspect-video"
              />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
