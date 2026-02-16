import { S3Client } from "@aws-sdk/client-s3";

const yandexS3 = new S3Client({
  region: "kz1",
  endpoint: "https://storage.yandexcloud.kz",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY_ID!,
    secretAccessKey: process.env.YC_SECRET_ACCESS_KEY!,
  },
});

export default yandexS3;
