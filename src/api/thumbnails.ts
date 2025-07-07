import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { getAssetDiskPath, getAssetURL, mediaTypeToExt } from "./assets";


export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
	const { videoId } = req.params as { videoId?: string };
	if (!videoId) {
		throw new BadRequestError("Invalid video ID");
	}

	const token = getBearerToken(req.headers);
	const userID = validateJWT(token, cfg.jwtSecret);

	console.log("uploading thumbnail for video", videoId, "by user", userID);

	const video = getVideo(cfg.db, videoId)
	if (!video) {
		throw new NotFoundError("cant find video");
	}
	if (video.userID !== userID) {
		throw new UserForbiddenError("user not authorized");
	}

	const formData = await req.formData();
	const image = formData.get("thumbnail");
	if (!(image instanceof File)) {
		throw new BadRequestError("wrong file format");
	}

	const MAX_UPLOAD_SIZE = 10 << 20;
	if (image.size > MAX_UPLOAD_SIZE) {
		throw new BadRequestError("file exceeds upload limit");
	}

	const mediaType = image.type;
	if (!mediaType) {
		throw new BadRequestError("media type missing")
	}

	const ext = mediaTypeToExt(mediaType);
	const filename = `${videoId}${ext}`;

	const assetDiskPath = getAssetDiskPath(cfg, filename);
	await Bun.write(assetDiskPath, image);

	const urlPath = getAssetURL(cfg, filename);
	video.thumbnailURL = urlPath;
	updateVideo(cfg.db, video)

	return respondWithJSON(200, video);
}
