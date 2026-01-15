import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // ファイルサイズチェック
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'ファイルサイズは2MB以下にしてください' }, { status: 400 });
    }

    // ファイルタイプチェック
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: '画像ファイル（JPEG, PNG, GIF, WebP）のみ対応しています' }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const ext = file.name.split('.').pop();
    const fileName = `${session.twitchUserId}-${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage
      .from('card-images')
      .upload(fileName, file, {
        contentType: file.type,
        upsert: false,
      });

    if (error) {
      console.error('[Upload API] Supabase upload error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('card-images')
      .getPublicUrl(data.path);

    return NextResponse.json({ url: publicUrl });
  } catch (error) {
    console.error('[Upload API] Error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
