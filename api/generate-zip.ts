// Corrected and Vercel-compatible version of your generate-zip.ts
import type { VercelRequest, VercelResponse } from 'vercel';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { createClient } from '@supabase/supabase-js';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

// Ensure ffmpeg knows where to find the binary
ffmpeg.setFfmpegPath(ffmpegPath!);

// Supabase client setup with env vars
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Vercel function entry point
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { albumId } = req.query;

  if (!albumId || typeof albumId !== 'string') {
    return res.status(400).json({ error: 'Missing albumId' });
  }

  try {
    const { data: tracks, error } = await supabase
      .from('tracks')
      .select('id, title, track_number')
      .eq('album_id', albumId);

    if (error || !tracks || tracks.length === 0) {
      return res.status(404).json({ error: 'No tracks found for album' });
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'album-'));
    const zip = new AdmZip();

    for (const track of tracks) {
      const wavPath = `${track.id}.wav`;
      const { data: wavFile } = await supabase.storage
        .from('audio-files')
        .download(wavPath);

      if (!wavFile) continue;

      const wavTempPath = path.join(tempDir, `${track.id}.wav`);
      const mp3TempPath = path.join(tempDir, `${track.track_number} - ${track.title}.mp3`);

      const fileBuffer = Buffer.from(await wavFile.arrayBuffer());
      fs.writeFileSync(wavTempPath, fileBuffer);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(wavTempPath)
          .audioBitrate(192)
          .toFormat('mp3')
          .save(mp3TempPath)
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });

      zip.addLocalFile(mp3TempPath, '', `${track.track_number} - ${track.title}.mp3`);
    }

    const zipBuffer = zip.toBuffer();
    const zipName = `${albumId}.zip`;
    const { error: uploadError } = await supabase.storage
      .from('archives')
      .upload(zipName, zipBuffer, {
        contentType: 'application/zip',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const { data: signed } = await supabase.storage
      .from('archives')
      .createSignedUrl(zipName, 900); // valid 15 min

    await supabase.from('album_downloads').upsert({
      album_id: albumId,
      zip_file_path: zipName,
      zip_file_size: zipBuffer.length,
      generated_at: new Date().toISOString(),
      status: 'ready',
    }, { onConflict: ['album_id'] });

    return res.status(200).json({ downloadUrl: signed?.signedUrl });
  } catch (err) {
    console.error('Error generating ZIP:', err);
    return res.status(500).json({ error: 'Failed to generate zip' });
  }
}
