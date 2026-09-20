package com.itsmemusicchilly.gachamvplayer;

import android.graphics.Bitmap;
import android.util.Log;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.io.ByteArrayOutputStream;
import java.util.EnumMap;
import java.util.Map;

/**
 * Utility for generating offline QR code bitmaps and PNG bytes using ZXing.
 */
public final class QRCodeUtil {

    private static final String TAG = "QRCodeUtil";

    private QRCodeUtil() {}

    public static Bitmap generateQrBitmap(String text, int width, int height) {
        if (text == null || text.trim().isEmpty()) return null;
        try {
            QRCodeWriter writer = new QRCodeWriter();
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            hints.put(EncodeHintType.MARGIN, 1); // Compact 1-module quiet zone

            BitMatrix matrix = writer.encode(text.trim(), BarcodeFormat.QR_CODE, width, height, hints);
            int matrixWidth = matrix.getWidth();
            int matrixHeight = matrix.getHeight();

            Bitmap bitmap = Bitmap.createBitmap(matrixWidth, matrixHeight, Bitmap.Config.RGB_565);
            for (int x = 0; x < matrixWidth; x++) {
                for (int y = 0; y < matrixHeight; y++) {
                    bitmap.setPixel(x, y, matrix.get(x, y) ? 0xFF000000 : 0xFFFFFFFF);
                }
            }
            return bitmap;
        } catch (Exception e) {
            Log.e(TAG, "Failed to generate QR code bitmap: " + e.getMessage());
            return null;
        }
    }

    public static byte[] generateQrPngBytes(String text, int width, int height) {
        Bitmap bmp = generateQrBitmap(text, width, height);
        if (bmp == null) return new byte[0];
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            bmp.compress(Bitmap.CompressFormat.PNG, 100, baos);
            return baos.toByteArray();
        } catch (Exception e) {
            Log.e(TAG, "Failed to compress QR bitmap to PNG: " + e.getMessage());
            return new byte[0];
        }
    }
}
