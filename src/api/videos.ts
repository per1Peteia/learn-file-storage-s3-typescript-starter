import { respondWithJSON } from "./json";

import { randomBytes } from "crypto"
import { type ApiConfig } from "../config";
import { type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import path from "path/posix";
import { rm } from "fs/promises";

const MAX_UPLOAD_LIMIT = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
	const { videoId } = req.params as { videoId?: string };
	if (!videoId) {
		throw new BadRequestError("invalid video id");
	}

	const token = getBearerToken(req.headers);
	const userId = validateJWT(token, cfg.jwtSecret);

	console.log(`uploading video ${videoId} by user ${userId}`);

	const video = getVideo(cfg.db, videoId);

	if (!video) {
		throw new NotFoundError("video not found");
	}
	if (video.userID !== userId) {
		throw new UserForbiddenError("user not authorized");
	}

	const formData = await req.formData();
	const file = formData.get("video");
	if (!(file instanceof File)) {
		throw new BadRequestError("data is not a file");
	}

	if (file.size > MAX_UPLOAD_LIMIT) {
		throw new BadRequestError("file exceeds upload limit (1GB)");
	}

	const mediaType = file.type;
	if (mediaType !== "video/mp4") {
		throw new BadRequestError("wrong media type");
	}

	// write a temporary video file for preprocessing
	const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
	await Bun.write(tempFilePath, file);
	// determine aspect ratio for bucket 'filesystem'
	const ratio = await getVideoAspectRatio(tempFilePath)
	console.log(`file ratio is: ${ratio}`);
	// generate key for bucket
	let key = `${ratio}/${randomBytes(32).toHex()}.mp4`;
	// process video for fast start
	const tempProcessedFilePath = await processVideoForFastStart(tempFilePath)
	// prepare for s3 upload
	const videoFile = Bun.file(tempProcessedFilePath);

	// upload to s3 bucket
	const s3File = cfg.s3Client.file(key, { bucket: cfg.s3Bucket });
	await s3File.write(videoFile, { type: mediaType });

	video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
	updateVideo(cfg.db, video)

	await Promise.all([rm(tempFilePath, { force: true })]);

	console.log("video upload complete.")
	return respondWithJSON(200, video);
}


type Ratio = { width: number, height: number }

async function getVideoAspectRatio(filePath: string) {
	const proc = Bun.spawn(
		[
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height",
			"-of",
			"json",
			filePath,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		}
	);

	await proc.exited;

	if (proc.exitCode === 0) {
		console.log("ffprobe completed successfully.");
		console.log("determining file ratio ...");

		const out = await proc.stdout.text()
		const data = JSON.parse(out, (key, value) => {
			if (key === "width") {
				return parseInt(value);
			}
			if (key === "height") {
				return parseInt(value);
			}
			return value;
		});

		const ratio: Ratio = {
			width: data.streams[0].width,
			height: data.streams[0].height,
		};

		const fileRatio = ratio.width / ratio.height;
		if (fileRatio >= 1.70 && fileRatio <= 1.80) return "landscape";
		if (fileRatio >= 0.50 && fileRatio <= 0.60) return "portrait";
		return "other";

	} else {
		console.error(`ffprobe failed with exit code: ${proc.exitCode}`);
		if (proc.signalCode) {
			console.error(`process killed by signal: ${proc.signalCode}`);
		}
		if (proc.stderr) {
			console.error(`Error: ${proc.stderr}`);
		}
	}
}

async function processVideoForFastStart(inFilePath: string) {
	const outFilePath = inFilePath + ".processed";

	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-i",
			inFilePath,
			"-movflags",
			"faststart",
			"-map_metadata",
			"0",
			"-codec",
			"copy",
			"-f",
			"mp4",
			outFilePath,
		],
		{
			stdout: null,
			stderr: "pipe",
		}
	);

	await proc.exited;
	if (proc.exitCode !== 0) {
		console.error(`ffmpeg failed with exit code: ${proc.exitCode}`);
		if (proc.signalCode) {
			console.error(`process killed by signal: ${proc.signalCode}`);
		}
		if (proc.stderr) {
			console.error(`Error: ${proc.stderr}`);
			throw new Error(`${proc.stderr}`);
		}

	}

	console.log("successfully processed video for fast start");
	return outFilePath;
}
